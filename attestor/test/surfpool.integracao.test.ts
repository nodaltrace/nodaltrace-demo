// Integração local: Surfpool embutido (@solana/surfpool), que clona o programa SAS do remoto sob demanda (só leitura;
// nenhuma transação sai da máquina). Sem rede para clonar o SAS, a suíte é pulada com o motivo.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Surfnet } from '@solana/surfpool';
import { createKeyPairSignerFromBytes, createNoopSigner, type KeyPairSigner } from '@solana/kit';
import { novoPar } from '../src/chaves.js';
import { criarRpc, type RpcSolana } from '../src/rede.js';
import { derivarPdas, PROGRAMA_SAS } from '../src/sas.js';
import { assinarPedido, criarServidor, type ContextoServidor } from '../src/servidor.js';
import { setup } from '../src/setup.js';
import { airdrop, PISO_PADRAO } from '../src/fundos.js';
import { relatorio } from './dados.js';

const SEG = 'segredo-de-integracao-com-mais-de-32-caracteres';

let surfnet: Surfnet | undefined;
let rpc: RpcSolana;
let motivoPular: string | undefined;

// O Surfnet embutido nasce offline; o remoto tem de ser explícito. Devnet por padrão (o SAS tem o mesmo id lá).
const REMOTO = process.env.NT_SURFPOOL_REMOTO ?? 'https://api.devnet.solana.com';

try {
    surfnet = Surfnet.startWithConfig({ remoteRpcUrl: REMOTO, offline: false });
    rpc = criarRpc(surfnet.rpcUrl);
    const prog = await rpc.getAccountInfo(PROGRAMA_SAS, { encoding: 'base64' }).send();
    if (!prog.value?.executable) motivoPular = 'Surfpool não conseguiu clonar o programa SAS do remoto (sem rede?)';
} catch (e) {
    motivoPular = `Surfpool indisponível: ${(e as Error).message}`;
}
if (motivoPular) console.warn(`[integração pulada] ${motivoPular}`);

async function assinante(): Promise<KeyPairSigner> {
    return createKeyPairSignerFromBytes(await novoPar());
}

function servir(ctx: ContextoServidor): Promise<{ srv: Server; base: string }> {
    const srv = criarServidor(ctx);
    return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ srv, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` })));
}

async function pedir(base: string, metodo: string, caminho: string, corpo?: unknown) {
    const texto = corpo === undefined ? '' : JSON.stringify(corpo);
    const tempo = String(Math.floor(Date.now() / 1000));
    const r = await fetch(base + caminho, {
        method: metodo,
        headers: { 'x-nt-tempo': tempo, 'x-nt-assinatura': assinarPedido(SEG, tempo, metodo, caminho, texto), 'content-type': 'application/json' },
        body: metodo === 'GET' ? undefined : texto,
    });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
}

describe.skipIf(Boolean(motivoPular))('Surfpool: setup + atestar + ler', () => {
    let autoridade: KeyPairSigner, atestador: KeyPairSigner;
    const fechar: (() => void)[] = [];

    beforeAll(async () => {
        [autoridade, atestador] = await Promise.all([assinante(), assinante()]);
        for (const a of [autoridade, atestador]) surfnet!.fundSol(a.address, 2_000_000_000);
    }, 60_000);

    afterAll(() => {
        fechar.forEach(f => f());
        surfnet?.stop();
    });

    // Sem confirmar, o setup só conhece endereços (assinantes vazios), como na CLI sem senha.
    const opcoes = (confirmar: boolean, quem = atestador) => ({
        rpc,
        rpcUrl: surfnet!.rpcUrl,
        cluster: 'localnet' as const,
        autoridade: confirmar ? autoridade : createNoopSigner(autoridade.address),
        atestador: createNoopSigner(quem.address),
        confirmar,
        log: () => {},
    });

    const contexto = async (mudar: Partial<ContextoServidor> = {}): Promise<ContextoServidor> => ({
        rpc,
        rpcUrl: surfnet!.rpcUrl,
        cluster: 'localnet',
        segredo: SEG,
        autoridade: autoridade.address,
        pdas: await derivarPdas(autoridade.address),
        atestador,
        ...mudar,
    });

    it('setup sem --confirmar só simula; com --confirmar cria; de novo não faz nada', async () => {
        const pdas = await derivarPdas(autoridade.address);
        const a = await setup(opcoes(false));
        expect(a).toMatchObject({ criar: ['credencial', 'NT_RELATORIO'], simulacaoOk: true, enviado: false });
        expect((await rpc.getAccountInfo(pdas.credencial, { encoding: 'base64' }).send()).value).toBeNull();
        const b = await setup(opcoes(true));
        expect(b.enviado).toBe(true);
        const c = await setup(opcoes(true));
        expect(c).toMatchObject({ criar: [], enviado: false });
    }, 120_000);

    it('atesta, lê com a transação, ja_existe, conflito, correção e saúde', async () => {
        const { srv, base } = await servir(await contexto());
        fechar.push(() => srv.close());

        const um = relatorio(1);
        const r = await pedir(base, 'POST', '/atestar', { schema: 'NT_RELATORIO', ...um });
        expect(r.status, JSON.stringify(r.json)).toBe(200);
        expect(r.json).toMatchObject({ cluster: 'localnet' });
        expect(typeof r.json.assinatura).toBe('string');
        expect(r.json.slot).toBeGreaterThan(0);

        const lida = await pedir(base, 'GET', `/atestacao?schema=NT_RELATORIO&nonce=${um.nonce}`);
        expect(lida.status).toBe(200);
        expect(lida.json).toMatchObject({ existe: true, pda: r.json.pda, campos: um.campos, assinatura: r.json.assinatura, slot: r.json.slot });

        const de_novo = await pedir(base, 'POST', '/atestar', { schema: 'NT_RELATORIO', ...um });
        expect(de_novo.status).toBe(409);
        expect(de_novo.json).toMatchObject({ erro: 'ja_existe', pda: r.json.pda });

        // Mesmo número, outro documento: a conta da série e do número já existe, então nada muda na rede.
        const outro = relatorio(1, { root: 'ab'.repeat(32) });
        const conflito = await pedir(base, 'POST', '/atestar', { schema: 'NT_RELATORIO', ...outro });
        expect(conflito.status).toBe(409);
        expect(conflito.json).toMatchObject({ erro: 'conflito', pda: r.json.pda });

        const correcao = relatorio(2, { replaces: 1 });
        const r2 = await pedir(base, 'POST', '/atestar', { schema: 'NT_RELATORIO', ...correcao });
        expect(r2.status, JSON.stringify(r2.json)).toBe(200);
        expect((await pedir(base, 'GET', `/atestacao?schema=NT_RELATORIO&nonce=${correcao.nonce}`)).json.campos.replaces).toBe(1);

        const nada = await pedir(base, 'GET', `/atestacao?schema=NT_RELATORIO&nonce=${relatorio(99).nonce}`);
        expect(nada.json).toEqual({ existe: false });

        const s = await pedir(base, 'GET', '/saude');
        expect(s.status).toBe(200);
        expect(s.json).toMatchObject({
            autoridade: autoridade.address,
            atestador: atestador.address,
            existem: { credencial: true, NT_RELATORIO: true },
            assinante_autorizado: true,
        });
        expect(s.json.saldo).toBeGreaterThan(0);
    }, 120_000);

    it('simulação que falha devolve 422 com logs (assinante fora da credencial)', async () => {
        const intruso = await assinante();
        surfnet!.fundSol(intruso.address, 1_000_000_000);
        const { srv, base } = await servir(await contexto({ atestador: intruso }));
        fechar.push(() => srv.close());
        const r = await pedir(base, 'POST', '/atestar', { schema: 'NT_RELATORIO', ...relatorio(10) });
        expect(r.status).toBe(422);
        expect(r.json.erro).toBe('simulacao');
        expect(Array.isArray(r.json.logs) && r.json.logs.length > 0).toBe(true);
        expect((await pedir(base, 'GET', '/saude')).json.assinante_autorizado).toBe(false);
    }, 120_000);

    it('saldo do atestador abaixo do piso: 503 saldo, sem enviar nada', async () => {
        const { srv, base } = await servir(await contexto({ saldoMinimo: 10n ** 18n }));
        fechar.push(() => srv.close());
        const sem = relatorio(11);
        const r = await pedir(base, 'POST', '/atestar', { schema: 'NT_RELATORIO', ...sem });
        expect(r.status).toBe(503);
        expect(r.json.erro).toBe('saldo');
        expect((await pedir(base, 'GET', `/atestacao?schema=NT_RELATORIO&nonce=${sem.nonce}`)).json).toEqual({ existe: false });
    }, 120_000);

    // Chave vazada: o setup com outro atestador troca o assinante autorizado; o antigo deixa de conseguir atestar.
    it('setup com outro atestador troca o assinante da credencial', async () => {
        const novo = await assinante();
        surfnet!.fundSol(novo.address, 1_000_000_000);
        expect(await setup(opcoes(true, novo))).toMatchObject({ criar: ['assinantes'], enviado: true });

        const antigo = await servir(await contexto());
        fechar.push(() => antigo.srv.close());
        expect((await pedir(antigo.base, 'POST', '/atestar', { schema: 'NT_RELATORIO', ...relatorio(12) })).status).toBe(422);

        const atual = await servir(await contexto({ atestador: novo }));
        fechar.push(() => atual.srv.close());
        expect((await pedir(atual.base, 'POST', '/atestar', { schema: 'NT_RELATORIO', ...relatorio(12) })).status).toBe(200);
        // Os registros feitos pelo atestador antigo continuam lá.
        expect((await pedir(atual.base, 'GET', `/atestacao?schema=NT_RELATORIO&nonce=${relatorio(1).nonce}`)).json.existe).toBe(true);
    }, 120_000);

    it('fundos: airdrop só para quem está abaixo do piso', async () => {
        const [a, b] = await Promise.all([assinante(), assinante()]);
        const end = { atestador: a.address, autoridade: b.address };
        expect(await airdrop(rpc, 'localnet', end, PISO_PADRAO, () => {})).toEqual(['atestador', 'autoridade']);
        const saldo = async (x: string) => (await rpc.getBalance(x as never, { commitment: 'confirmed' }).send()).value;
        const antes = await saldo(a.address);
        // De novo, acima do piso: não pede outro.
        expect(await airdrop(rpc, 'localnet', end, PISO_PADRAO, () => {})).toEqual(['atestador', 'autoridade']);
        expect(await saldo(a.address)).toBe(antes);
    }, 120_000);
});
