// Montagem, simulação, envio e confirmação de transações v0.
import {
    appendTransactionMessageInstructions,
    assertIsTransactionWithinSizeLimit,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    partiallySignTransactionMessageWithSigners,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type Instruction,
    type Signature,
    type Transaction,
    type TransactionSigner,
} from '@solana/kit';
import type { RpcSolana } from './rede.js';

export type CodigoErro = 'simulacao' | 'rpc' | 'saldo' | 'ja_existe' | 'conflito' | 'entrada';

export const STATUS_ERRO: Record<CodigoErro, number> = {
    simulacao: 422,
    rpc: 502,
    saldo: 503,
    ja_existe: 409,
    conflito: 409,
    entrada: 400,
};

export class ErroAtestor extends Error {
    constructor(
        readonly codigo: CodigoErro,
        detalhe: string,
        readonly extra: Record<string, unknown> = {},
    ) {
        super(detalhe);
    }
    get status(): number {
        return STATUS_ERRO[this.codigo];
    }
    corpo(): Record<string, unknown> {
        return { erro: this.codigo, detalhe: this.message, ...this.extra };
    }
}

/** Embrulha falhas de RPC num ErroAtestor('rpc'). */
export async function noRpc<T>(o_que: string, f: () => Promise<T>): Promise<T> {
    try {
        return await f();
    } catch (e) {
        if (e instanceof ErroAtestor) throw e;
        throw new ErroAtestor('rpc', `${o_que}: ${(e as Error).message}`);
    }
}

export type Lifetime = { blockhash: string; lastValidBlockHeight: bigint };

export async function ultimoBlockhash(rpc: RpcSolana): Promise<Lifetime> {
    const { value } = await noRpc('getLatestBlockhash', () => rpc.getLatestBlockhash({ commitment: 'confirmed' }).send());
    return value;
}

export async function montarEAssinar(
    pagadorTaxa: TransactionSigner,
    instrucoes: Instruction[],
    vida: Lifetime,
    parcial: boolean,
): Promise<Transaction> {
    const msg = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(pagadorTaxa, m),
        m => setTransactionMessageLifetimeUsingBlockhash(vida as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0], m),
        m => appendTransactionMessageInstructions(instrucoes, m),
    );
    const tx = parcial ? await partiallySignTransactionMessageWithSigners(msg) : await signTransactionMessageWithSigners(msg);
    assertIsTransactionWithinSizeLimit(tx);
    return tx;
}

export type Simulacao = { ok: boolean; erro: unknown; logs: string[]; unidades: bigint | null };

/** Simula sem verificar assinaturas (o plano do setup usa assinantes vazios) e com o blockhash da própria transação. */
export async function simular(rpc: RpcSolana, tx: Transaction): Promise<Simulacao> {
    const wire = getBase64EncodedWireTransaction(tx);
    const { value } = await noRpc('simulateTransaction', () =>
        rpc
            .simulateTransaction(wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' })
            .send(),
    );
    return { ok: value.err === null, erro: value.err, logs: [...(value.logs ?? [])], unidades: value.unitsConsumed ?? null };
}

export function json(v: unknown): string {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

/** Envia pelo RPC. Devolve a assinatura. */
export async function enviarDireto(rpc: RpcSolana, tx: Transaction): Promise<Signature> {
    const wire = getBase64EncodedWireTransaction(tx);
    return noRpc('sendTransaction', () => rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true }).send());
}

/** Espera `confirmed` por polling (sem WebSocket). Falha se o blockhash expirar ou a transação falhar. */
export async function confirmar(
    rpc: RpcSolana,
    assinatura: Signature,
    vida: Lifetime,
    intervaloMs = 500,
): Promise<bigint> {
    for (;;) {
        const { value } = await noRpc('getSignatureStatuses', () => rpc.getSignatureStatuses([assinatura]).send());
        const st = value[0];
        if (st) {
            if (st.err) throw new ErroAtestor('rpc', `transação ${assinatura} falhou: ${json(st.err)}`, { assinatura });
            if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return st.slot;
        }
        const altura = await noRpc('getBlockHeight', () => rpc.getBlockHeight({ commitment: 'confirmed' }).send());
        if (altura > vida.lastValidBlockHeight) {
            throw new ErroAtestor('rpc', `transação ${assinatura} não confirmou antes de o blockhash expirar`, { assinatura });
        }
        await new Promise(r => setTimeout(r, intervaloMs));
    }
}

/**
 * Hora do bloco (RFC 3339 UTC, precisão de segundo), ou null se o RPC ainda não a tiver: logo depois da confirmação o
 * bloco pode não estar disponível, então tenta algumas vezes.
 */
export async function horaDoBloco(rpc: RpcSolana, slot: bigint, tentativas = 6, intervaloMs = 500): Promise<string | null> {
    for (let i = 0; i < tentativas; i++) {
        try {
            const t = await rpc.getBlockTime(slot).send();
            if (t !== null) return new Date(Number(t) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        } catch {
            // "Block not available" logo após a confirmação: tenta de novo
        }
        await new Promise(r => setTimeout(r, intervaloMs));
    }
    return null;
}
