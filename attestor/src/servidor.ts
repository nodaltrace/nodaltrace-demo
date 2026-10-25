// Servidor HTTP interno do attestor (CONTRATO §5). Toda requisição autenticada por HMAC.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { fetchEncodedAccounts, isAddress, type Address, type KeyPairSigner } from '@solana/kit';
import { decodeCredential, decodeSchema } from '@solana/attestation';
import { atestar, ler, lerPedido, type Contexto } from './atestar.js';
import { assinanteDeSegredo, caminhoCofre, carregarAssinante, dirChaves } from './chaves.js';
import { ErroAtestor, noRpc } from './envio.js';
import { conferirRede, criarRpc, lerCluster, RPC_PADRAO, urlPublica } from './rede.js';
import { derivarPdas, ErroEntrada, NOME_SCHEMA, PROGRAMA_SAS, schemaConfere } from './sas.js';

export const JANELA_S = 60;
export const LIMITE_CORPO = 16 * 1024;

export type ContextoServidor = Contexto & { autoridade: Address; segredo: string; rpcUrl: string; agora?: () => number };

// ---- HMAC ----

export function assinarPedido(segredo: string, tempo: string, metodo: string, caminho: string, corpo: string): string {
    return createHmac('sha256', segredo).update(`${tempo}\n${metodo}\n${caminho}\n${corpo}`).digest('hex');
}

export function verificarHmac(
    segredo: string,
    tempo: string | undefined,
    assinatura: string | undefined,
    metodo: string,
    caminho: string,
    corpo: string,
    agora = Math.floor(Date.now() / 1000),
): boolean {
    if (!tempo || !assinatura || !/^\d{1,12}$/.test(tempo) || !/^[0-9a-f]{64}$/.test(assinatura)) return false;
    if (Math.abs(agora - Number(tempo)) > JANELA_S) return false;
    const esperado = Buffer.from(assinarPedido(segredo, tempo, metodo, caminho, corpo), 'hex');
    const recebido = Buffer.from(assinatura, 'hex');
    return recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
}

// ---- HTTP ----

class CorpoGrande extends Error {}

function lerCorpo(req: IncomingMessage): Promise<string> {
    return new Promise((ok, falha) => {
        const partes: Buffer[] = [];
        let total = 0;
        if (Number(req.headers['content-length'] ?? 0) > LIMITE_CORPO) return falha(new CorpoGrande());
        req.on('data', (p: Buffer) => {
            total += p.length;
            if (total > LIMITE_CORPO) return falha(new CorpoGrande()); // a resposta 413 fecha a conexão
            partes.push(p);
        });
        req.on('end', () => ok(Buffer.concat(partes).toString('utf8')));
        req.on('error', falha);
    });
}

function responder(res: ServerResponse, status: number, corpo: unknown): void {
    const texto = JSON.stringify(corpo);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(texto) });
    res.end(texto);
}

function cabecalho(req: IncomingMessage, nome: string): string | undefined {
    const v = req.headers[nome];
    return Array.isArray(v) ? undefined : v;
}

async function saude(ctx: ContextoServidor): Promise<Record<string, unknown>> {
    const { pdas } = ctx;
    const [cred, schema] = await noRpc('getMultipleAccounts', () =>
        fetchEncodedAccounts(ctx.rpc, [pdas.credencial, pdas.schema], { commitment: 'confirmed' }),
    );
    // A credencial existe com a nossa autoridade, e o atestador é um dos assinantes autorizados dela?
    let credencial = false;
    let autorizado = false;
    if (cred.exists && cred.programAddress === PROGRAMA_SAS) {
        try {
            const c = decodeCredential(cred).data;
            credencial = c.authority === ctx.autoridade;
            autorizado = credencial && c.authorizedSigners.includes(ctx.atestador.address);
        } catch {
            credencial = false;
        }
    }
    let schemaOk = false;
    if (schema.exists && schema.programAddress === PROGRAMA_SAS) {
        try {
            schemaOk = schemaConfere(pdas.credencial, decodeSchema(schema).data);
        } catch {
            schemaOk = false;
        }
    }
    const { value: saldo } = await noRpc('getBalance', () => ctx.rpc.getBalance(ctx.atestador.address, { commitment: 'confirmed' }).send());
    return {
        cluster: ctx.cluster,
        rpc: urlPublica(ctx.rpcUrl),
        programa: PROGRAMA_SAS,
        autoridade: ctx.autoridade,
        credencial: pdas.credencial,
        schema: pdas.schema,
        existem: { credencial, [NOME_SCHEMA]: schemaOk },
        atestador: ctx.atestador.address,
        assinante_autorizado: autorizado,
        saldo: Number(saldo),
        saldo_minimo: Number(ctx.saldoMinimo ?? 0n),
    };
}

async function tratar(ctx: ContextoServidor, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const metodo = req.method ?? '';
    const caminho = req.url ?? '/';
    // Healthcheck do compose: sem HMAC, sem RPC, sem segredo.
    if (metodo === 'GET' && caminho === '/vivo') {
        req.resume();
        return responder(res, 200, { ok: true });
    }
    let corpo: string;
    try {
        corpo = await lerCorpo(req);
    } catch (e) {
        if (e instanceof CorpoGrande) {
            res.setHeader('connection', 'close');
            res.on('finish', () => req.destroy());
            return responder(res, 413, { erro: 'entrada', detalhe: 'corpo grande demais' });
        }
        throw e;
    }
    const agora = ctx.agora?.() ?? Math.floor(Date.now() / 1000);
    if (!verificarHmac(ctx.segredo, cabecalho(req, 'x-nt-tempo'), cabecalho(req, 'x-nt-assinatura'), metodo, caminho, corpo, agora)) {
        return responder(res, 401, { erro: 'nao_autorizado', detalhe: 'assinatura ausente, inválida ou fora da janela' });
    }
    const url = new URL(caminho, 'http://attestor');

    if (metodo === 'POST' && url.pathname === '/atestar') {
        let dado: unknown;
        try {
            dado = JSON.parse(corpo);
        } catch {
            throw new ErroEntrada('corpo não é JSON');
        }
        const pedido = lerPedido(dado);
        const r = await atestar(ctx, pedido);
        console.log(`atestado ${NOME_SCHEMA} ${pedido.campos.series}/${pedido.campos.number} ${r.pda} ${r.assinatura} slot ${r.slot}`);
        return responder(res, 200, r);
    }
    if (metodo === 'GET' && url.pathname === '/atestacao') {
        return responder(res, 200, await ler(ctx, url.searchParams.get('schema') ?? '', url.searchParams.get('nonce') ?? ''));
    }
    if (metodo === 'GET' && url.pathname === '/saude') {
        return responder(res, 200, await saude(ctx));
    }
    responder(res, 404, { erro: 'entrada', detalhe: 'rota desconhecida' });
}

export function criarServidor(ctx: ContextoServidor): Server {
    const srv = createServer((req, res) => {
        tratar(ctx, req, res).catch((e: unknown) => {
            if (res.headersSent) return res.destroy();
            if (e instanceof ErroAtestor) {
                if (e.codigo !== 'ja_existe') console.warn(`${req.method} ${req.url?.split('?')[0]} → ${e.codigo}: ${e.message}`);
                return responder(res, e.status, e.corpo());
            }
            if (e instanceof ErroEntrada) return responder(res, 400, { erro: 'entrada', detalhe: e.message });
            console.error('erro inesperado', e);
            responder(res, 500, { erro: 'interno', detalhe: 'erro inesperado' });
        });
    });
    srv.requestTimeout = 180_000;
    return srv;
}

// ---- Subida ----

function exigir(env: NodeJS.ProcessEnv, nome: string): string {
    const v = env[nome];
    if (!v) throw new Error(`${nome} não definida`);
    return v;
}

export const SALDO_MINIMO_PADRAO = 50_000_000; // 0,05 SOL

function lerInteiro(env: NodeJS.ProcessEnv, nome: string, padrao: number): string {
    const v = env[nome];
    if (v === undefined || v === '') return String(padrao);
    if (!/^\d{1,19}$/.test(v)) throw new Error(`${nome} tem de ser um inteiro não negativo`);
    return v;
}

export async function contextoDoAmbiente(env: NodeJS.ProcessEnv = process.env): Promise<ContextoServidor> {
    const cluster = lerCluster(env.NT_SOLANA_CLUSTER);
    const rpcUrl = env.NT_SOLANA_RPC || RPC_PADRAO;
    const segredo = exigir(env, 'NT_ATTESTOR_SEGREDO');
    if (segredo.length < 32) throw new Error('NT_ATTESTOR_SEGREDO curto demais (mínimo 32 caracteres)');
    // A chave da credencial fica fora do servidor (CONTRATO §8): recusa subir se a senha ou o cofre dela vierem junto.
    if (env.NT_CHAVES_SENHA_AUTORIDADE) throw new Error('NT_CHAVES_SENHA_AUTORIDADE não pode chegar ao servidor (só ao setup)');
    if (env.NT_CHAVE_AUTORIDADE) throw new Error('NT_CHAVE_AUTORIDADE não pode chegar ao servidor (só ao setup)');
    const dir = dirChaves(env);
    if (existsSync(caminhoCofre('autoridade', dir))) throw new Error('o cofre autoridade.json não pode estar montado no servidor');
    const autoridade = exigir(env, 'NT_AUTORIDADE');
    if (!isAddress(autoridade)) throw new Error('NT_AUTORIDADE não é um endereço');

    const saldoMinimo = BigInt(lerInteiro(env, 'NT_SALDO_MINIMO_LAMPORTS', SALDO_MINIMO_PADRAO));

    const rpc = criarRpc(rpcUrl);
    await conferirRede(cluster, rpcUrl, rpc, env);

    // Só o atestador: o cofre e a senha da autoridade nunca chegam ao servidor (CONTRATO §8). Na nuvem a chave chega
    // decifrada pelo Cloud KMS (NT_CHAVE_ATESTADOR); no Compose, cofre + senha.
    const atestador: KeyPairSigner = env.NT_CHAVE_ATESTADOR
        ? await assinanteDeSegredo(env.NT_CHAVE_ATESTADOR)
        : await carregarAssinante('atestador', exigir(env, 'NT_CHAVES_SENHA'), dir);
    // Tira os segredos do process.env só para que nada deste processo (subprocesso, log de env, dependência) os
    // repasse. NÃO os apaga do container: continuam em /proc/1/environ (legível pelo mesmo usuário) e na
    // Config.Env do Docker (docker inspect) enquanto o container existir; ./run.sh solana-down o remove.
    for (const n of ['NT_CHAVES_SENHA', 'NT_CHAVE_ATESTADOR', 'NT_ATTESTOR_SEGREDO']) {
        delete env[n];
    }
    return { rpc, rpcUrl, cluster, segredo, autoridade, pdas: await derivarPdas(autoridade), atestador, saldoMinimo };
}

async function principal(): Promise<void> {
    const ctx = await contextoDoAmbiente();
    const porta = Number(process.env.PORT ?? 8790);
    criarServidor(ctx).listen(porta, () => {
        console.log(
            `attestor em :${porta} cluster=${ctx.cluster} rpc=${urlPublica(ctx.rpcUrl)} credencial=${ctx.pdas.credencial} ` +
                `schema=${ctx.pdas.schema} atestador=${ctx.atestador.address}`,
        );
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    principal().catch(e => {
        console.error(`falha na subida: ${(e as Error).message}`);
        process.exit(1);
    });
}
