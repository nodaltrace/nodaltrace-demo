import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKeyPairSignerFromBytes, generateKeyPairSigner, getBase58Decoder } from '@solana/kit';
import { assinarPedido, contextoDoAmbiente, criarServidor, verificarHmac, type ContextoServidor } from '../src/servidor.js';
import { conferirUrl, RedeRecusada } from '../src/rede.js';
import { derivarPdas } from '../src/sas.js';
import { novoPar } from '../src/chaves.js';

const SEG = 'segredo-de-teste-com-mais-de-32-caracteres';
const T = 1_800_000_000;

describe('HMAC do attestor', () => {
    const sig = assinarPedido(SEG, String(T), 'POST', '/atestar', '{"a":1}');

    it('mensagem = tempo\\nMÉTODO\\ncaminho\\ncorpo', () => {
        const esperado = createHmac('sha256', SEG).update(`${T}\nPOST\n/atestar\n{"a":1}`).digest('hex');
        expect(sig).toBe(esperado);
    });
    it('aceita dentro da janela', () => {
        expect(verificarHmac(SEG, String(T), sig, 'POST', '/atestar', '{"a":1}', T + 60)).toBe(true);
        expect(verificarHmac(SEG, String(T), sig, 'POST', '/atestar', '{"a":1}', T - 60)).toBe(true);
    });
    it('recusa expirado', () => {
        expect(verificarHmac(SEG, String(T), sig, 'POST', '/atestar', '{"a":1}', T + 61)).toBe(false);
    });
    it('recusa adulterado (corpo, caminho, método, tempo, assinatura, segredo)', () => {
        expect(verificarHmac(SEG, String(T), sig, 'POST', '/atestar', '{"a":2}', T)).toBe(false);
        expect(verificarHmac(SEG, String(T), sig, 'POST', '/atestar?x=1', '{"a":1}', T)).toBe(false);
        expect(verificarHmac(SEG, String(T), sig, 'GET', '/atestar', '{"a":1}', T)).toBe(false);
        expect(verificarHmac(SEG, String(T + 1), sig, 'POST', '/atestar', '{"a":1}', T)).toBe(false);
        expect(verificarHmac(SEG, String(T), sig.replace(/^./, c => (c === '0' ? '1' : '0')), 'POST', '/atestar', '{"a":1}', T)).toBe(false);
        expect(verificarHmac('outro', String(T), sig, 'POST', '/atestar', '{"a":1}', T)).toBe(false);
        expect(verificarHmac(SEG, undefined, sig, 'POST', '/atestar', '{"a":1}', T)).toBe(false);
        expect(verificarHmac(SEG, String(T), sig.toUpperCase(), 'POST', '/atestar', '{"a":1}', T)).toBe(false);
    });
});

describe('servidor (sem rede)', () => {
    let srv: Server;
    let base: string;
    beforeAll(async () => {
        const a = await generateKeyPairSigner();
        const ctx = {
            segredo: SEG,
            rpcUrl: 'http://127.0.0.1:1',
            cluster: 'localnet',
            rpc: {} as never, // as rotas testadas aqui falham antes de tocar o RPC
            autoridade: a.address,
            pdas: await derivarPdas(a.address),
            atestador: a,
        } satisfies ContextoServidor;
        srv = criarServidor(ctx);
        await new Promise<void>(ok => srv.listen(0, '127.0.0.1', ok));
        base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>(ok => srv.close(() => ok())));

    const pedir = (metodo: string, caminho: string, corpo = '', assinar = true) => {
        const tempo = String(Math.floor(Date.now() / 1000));
        const cab: Record<string, string> = { 'content-type': 'application/json' };
        if (assinar) {
            cab['x-nt-tempo'] = tempo;
            cab['x-nt-assinatura'] = assinarPedido(SEG, tempo, metodo, caminho, corpo);
        }
        return fetch(base + caminho, { method: metodo, headers: cab, body: metodo === 'GET' ? undefined : corpo });
    };

    it('/vivo sem HMAC', async () => {
        const r = await fetch(base + '/vivo');
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ ok: true });
    });
    it('401 sem assinatura', async () => {
        const r = await pedir('GET', '/saude', '', false);
        expect(r.status).toBe(401);
    });
    it('400 entrada para corpo inválido', async () => {
        const r = await pedir('POST', '/atestar', '{"schema":"NT_LOTE"}');
        expect(r.status).toBe(400);
        expect(await r.json()).toMatchObject({ erro: 'entrada' });
    });
    it('400 para nonce inválido no GET', async () => {
        const r = await pedir('GET', '/atestacao?schema=NT_RELATORIO&nonce=xyz');
        expect(r.status).toBe(400);
    });
    it('413 para corpo grande', async () => {
        const r = await pedir('POST', '/atestar', 'x'.repeat(20_000));
        expect(r.status).toBe(413);
    });
});

describe('subida pelo ambiente', () => {
    // Pasta vazia: sem ela o padrão é ./chaves, que tem os cofres reais (inclusive autoridade.json) depois do solana-chaves.
    const semCofres = mkdtempSync(join(tmpdir(), 'nt-sem-cofres-'));
    afterAll(() => rmSync(semCofres, { recursive: true, force: true }));
    const base = {
        NT_CHAVES_DIR: semCofres,
        NT_SOLANA_CLUSTER: 'localnet',
        NT_SOLANA_RPC: 'http://127.0.0.1:1',
        NT_ATTESTOR_SEGREDO: SEG,
        NT_AUTORIDADE: '11111111111111111111111111111111',
    };
    it('recusa segredo vazio', async () => {
        await expect(contextoDoAmbiente({ ...base, NT_ATTESTOR_SEGREDO: '' })).rejects.toThrow(/NT_ATTESTOR_SEGREDO/);
    });
    it('sem chave do atestador, pede a senha do cofre', async () => {
        await expect(contextoDoAmbiente({ ...base })).rejects.toThrow(/NT_CHAVES_SENHA/);
    });
    it('recusa a senha da autoridade no servidor', async () => {
        await expect(contextoDoAmbiente({ ...base, NT_CHAVES_SENHA_AUTORIDADE: 'x'.repeat(12) })).rejects.toThrow(/NT_CHAVES_SENHA_AUTORIDADE/);
    });
    it('recusa o cofre da autoridade montado no servidor', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nt-chaves-'));
        try {
            writeFileSync(join(dir, 'autoridade.json'), '{}');
            await expect(contextoDoAmbiente({ ...base, NT_CHAVES_DIR: dir })).rejects.toThrow(/autoridade\.json/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('aceita a chave decifrada pela env (nuvem) e a tira do process.env', async () => {
        const par = await novoPar();
        const env: NodeJS.ProcessEnv = { ...base, NT_CHAVE_ATESTADOR: getBase58Decoder().decode(par) };
        const ctx = await contextoDoAmbiente(env);
        expect(ctx.atestador.address).toBe((await createKeyPairSignerFromBytes(par)).address);
        expect(ctx.autoridade).toBe(base.NT_AUTORIDADE);
        expect(env.NT_CHAVE_ATESTADOR).toBeUndefined();
        expect(env.NT_ATTESTOR_SEGREDO).toBeUndefined();
    });
    it('recusa chave inválida e a chave da autoridade', async () => {
        const p = getBase58Decoder().decode(await novoPar());
        await expect(contextoDoAmbiente({ ...base, NT_CHAVE_ATESTADOR: 'abc' })).rejects.toThrow(/64 bytes|base58/);
        await expect(contextoDoAmbiente({ ...base, NT_CHAVE_AUTORIDADE: p })).rejects.toThrow(/NT_CHAVE_AUTORIDADE/);
    });
    it('recusa piso de saldo inválido', async () => {
        await expect(contextoDoAmbiente({ ...base, NT_SALDO_MINIMO_LAMPORTS: '-1' })).rejects.toThrow(/NT_SALDO_MINIMO_LAMPORTS/);
    });
});

describe('trava de rede', () => {
    it('recusa mainnet sem a flag e RPC de mainnet com cluster devnet', () => {
        expect(() => conferirUrl('mainnet', 'https://api.mainnet-beta.solana.com', {})).toThrow(RedeRecusada);
        expect(() => conferirUrl('devnet', 'https://api.mainnet-beta.solana.com', {})).toThrow(RedeRecusada);
        expect(() => conferirUrl('devnet', 'http://api.devnet.solana.com', {})).toThrow(/HTTPS/);
        expect(() => conferirUrl('localnet', 'https://api.devnet.solana.com', {})).toThrow(/local/);
        expect(() => conferirUrl('devnet', 'https://api.devnet.solana.com', {})).not.toThrow();
        expect(() => conferirUrl('localnet', 'http://127.0.0.1:8899', {})).not.toThrow();
        expect(() => conferirUrl('localnet', 'http://surfpool:8899', { NT_LOCALNET_HOSTS: 'surfpool' })).not.toThrow();
    });
});
