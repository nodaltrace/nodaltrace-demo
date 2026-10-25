// Criação e leitura das atestações de relatório (CONTRATO §4, §5).
import { getCreateAttestationInstruction } from '@solana/attestation';
import { fetchEncodedAccount, type Address, type KeyPairSigner } from '@solana/kit';
import type { Cluster, RpcSolana } from './rede.js';
import {
    codificarCampos,
    conferirNonce,
    ContaInvalida,
    ErroEntrada,
    NOME_SCHEMA,
    nonceDeHex,
    pdaAtestacao,
    validarCampos,
    validarConta,
    type AtestacaoLida,
    type Campos,
    type Pdas,
} from './sas.js';
import { confirmar, enviarDireto, ErroAtestor, horaDoBloco, json, montarEAssinar, noRpc, simular, ultimoBlockhash } from './envio.js';

export type Contexto = {
    rpc: RpcSolana;
    cluster: Cluster;
    pdas: Pdas;
    /** Assinante autorizado da credencial; paga também a taxa e o aluguel da conta de atestação. */
    atestador: KeyPairSigner;
    /** Piso de saldo do `atestador` (lamports): abaixo dele, /atestar recusa com `saldo` (503). Ausente ou 0: sem piso. */
    saldoMinimo?: bigint;
};

export type Pedido = { nonce: string; campos: Campos };
/** A transação que criou a conta: assinatura, slot e hora do bloco (null se o RPC ainda não a tiver). */
export type Registro = { assinatura: string; slot: number; bloco_em: string | null };
export type Resultado = Registro & { pda: Address; cluster: Cluster };
export type Leitura = { existe: false } | ({ existe: true; pda: Address; campos: Campos } & Registro);

/** Valida o corpo de POST /atestar. */
export function lerPedido(corpo: unknown): Pedido {
    if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) throw new ErroEntrada('corpo tem de ser objeto JSON');
    const o = corpo as Record<string, unknown>;
    const sobram = Object.keys(o).filter(k => !['schema', 'nonce', 'campos'].includes(k));
    if (sobram.length) throw new ErroEntrada(`chaves desconhecidas: ${sobram.join(', ')}`);
    if (o.schema !== NOME_SCHEMA) throw new ErroEntrada(`schema tem de ser ${NOME_SCHEMA}`);
    if (typeof o.nonce !== 'string') throw new ErroEntrada('nonce ausente');
    nonceDeHex(o.nonce);
    const campos = validarCampos(o.campos);
    conferirNonce(o.nonce, campos);
    return { nonce: o.nonce, campos };
}

async function lerConta(ctx: Contexto, nonce: Address, pda: Address): Promise<AtestacaoLida | null> {
    const conta = await noRpc('getAccountInfo', () => fetchEncodedAccount(ctx.rpc, pda, { commitment: 'confirmed' }));
    if (!conta.exists) return null;
    try {
        return validarConta(conta, { pdas: ctx.pdas, nonce });
    } catch (e) {
        if (e instanceof ContaInvalida) throw new ErroAtestor('conflito', `conta ${pda} existe e não é válida: ${e.message}`, { pda });
        throw e;
    }
}

/** A transação que criou a conta: a assinatura mais antiga do endereço (a lista vem da mais nova para a mais antiga). */
async function registroDaConta(ctx: Contexto, pda: Address): Promise<Registro> {
    const lista = await noRpc('getSignaturesForAddress', () => ctx.rpc.getSignaturesForAddress(pda, { commitment: 'confirmed' }).send());
    const primeira = lista.at(-1);
    if (!primeira) throw new ErroAtestor('rpc', `nenhuma transação encontrada para a conta ${pda}`, { pda });
    const bloco_em = primeira.blockTime !== null && primeira.blockTime !== undefined
        ? new Date(Number(primeira.blockTime) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
        : await horaDoBloco(ctx.rpc, primeira.slot);
    return { assinatura: primeira.signature, slot: Number(primeira.slot), bloco_em };
}

/** GET /atestacao. */
export async function ler(ctx: Contexto, schema: string, nonceHex: string): Promise<Leitura> {
    if (schema !== NOME_SCHEMA) throw new ErroEntrada(`schema tem de ser ${NOME_SCHEMA}`);
    const nonce = nonceDeHex(nonceHex);
    const pda = await pdaAtestacao(ctx.pdas, nonce);
    const lida = await lerConta(ctx, nonce, pda);
    if (!lida) return { existe: false };
    return { existe: true, pda, campos: lida.campos, ...(await registroDaConta(ctx, pda)) };
}

function iguais(a: Uint8Array, b: Uint8Array): boolean {
    return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/** Já existe? Mesmos dados → ja_existe; outros dados → conflito. */
function conferirExistente(lida: AtestacaoLida, dados: Uint8Array): never {
    if (iguais(lida.dados, dados) && lida.expiry === 0n) {
        throw new ErroAtestor('ja_existe', 'a atestação já existe com os mesmos dados', { pda: lida.pda });
    }
    throw new ErroAtestor('conflito', 'a atestação já existe com dados diferentes', { pda: lida.pda });
}

// Uma atestação por PDA por vez neste processo.
const emCurso = new Map<string, Promise<unknown>>();
async function exclusivo<T>(chave: string, f: () => Promise<T>): Promise<T> {
    const anterior = emCurso.get(chave) ?? Promise.resolve();
    const atual = anterior.catch(() => undefined).then(f);
    emCurso.set(chave, atual);
    try {
        return await atual;
    } finally {
        if (emCurso.get(chave) === atual) emCurso.delete(chave);
    }
}

/** POST /atestar. */
export async function atestar(ctx: Contexto, pedido: Pedido): Promise<Resultado> {
    const nonce = nonceDeHex(pedido.nonce);
    const dados = codificarCampos(ctx.pdas.credencial, pedido.campos);
    const pda = await pdaAtestacao(ctx.pdas, nonce);

    return exclusivo(pda, async () => {
        const existente = await lerConta(ctx, nonce, pda);
        if (existente) conferirExistente(existente, dados);

        if (ctx.saldoMinimo) {
            const { value: saldo } = await noRpc('getBalance', () =>
                ctx.rpc.getBalance(ctx.atestador.address, { commitment: 'confirmed' }).send(),
            );
            if (saldo < ctx.saldoMinimo) {
                throw new ErroAtestor('saldo', `saldo do atestador (${saldo} lamports) abaixo do mínimo (${ctx.saldoMinimo} lamports)`, {
                    saldo: Number(saldo),
                    minimo: Number(ctx.saldoMinimo),
                });
            }
        }

        const ix = getCreateAttestationInstruction({
            payer: ctx.atestador,
            authority: ctx.atestador,
            credential: ctx.pdas.credencial,
            schema: ctx.pdas.schema,
            attestation: pda,
            nonce,
            data: dados,
            expiry: 0,
        });

        const vida = await ultimoBlockhash(ctx.rpc);
        const tx = await montarEAssinar(ctx.atestador, [ix], vida, false);

        const sim = await simular(ctx.rpc, tx);
        if (!sim.ok) {
            // Corrida: outra instância pode ter criado a conta entre a leitura e a simulação.
            const agora = await lerConta(ctx, nonce, pda);
            if (agora) conferirExistente(agora, dados);
            throw new ErroAtestor('simulacao', `simulação falhou: ${json(sim.erro)}`, { logs: sim.logs });
        }

        const assinatura = await enviarDireto(ctx.rpc, tx);
        const slot = await confirmar(ctx.rpc, assinatura, vida);
        return { pda, assinatura, slot: Number(slot), bloco_em: await horaDoBloco(ctx.rpc, slot), cluster: ctx.cluster };
    });
}
