import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateKeyPairSigner, getAddressDecoder, type Address, type EncodedAccount } from '@solana/kit';
import { getAttestationEncoder } from '@solana/attestation';
import { lerPedido } from '../src/atestar.js';
import {
    CAMPOS,
    codificarCampos,
    ContaInvalida,
    decodificarCampos,
    derivarPdas,
    ErroEntrada,
    nonceDeHex,
    nonceDoRelatorio,
    pdaAtestacao,
    PROGRAMA_SAS,
    validarConta,
} from '../src/sas.js';
import { h, relatorio, SERIE } from './dados.js';

const credencial = getAddressDecoder().decode(Buffer.alloc(32, 7)) as Address;

describe('nonce', () => {
    it('sha256(utf8("NT_RELATORIO:" + série + ":" + número)), número em decimal sem zeros', () => {
        expect(nonceDoRelatorio(SERIE, 7)).toBe(h(`NT_RELATORIO:${SERIE}:7`));
        expect(nonceDoRelatorio(SERIE, 7)).not.toBe(nonceDoRelatorio(SERIE, 8));
        expect(nonceDoRelatorio(SERIE, 7)).not.toBe(nonceDoRelatorio('1b6f6d8e-6d1c-4e8b-9a35-3c1d2f8a9b10', 7));
    });
});

// O caso `relatorio` dos vetores do contrato, o mesmo que a API, o frontend e docs/atestacao/verificar.py conferem.
const VETOR = JSON.parse(readFileSync(new URL('../../docs/atestacao/vetores.json', import.meta.url), 'utf8')).relatorio;

describe('vetores do contrato', () => {
    it('nonce e bytes dos campos no SAS', () => {
        expect(nonceDoRelatorio(VETOR.campos.series, VETOR.campos.number)).toBe(VETOR.nonce);
        expect(Buffer.from(codificarCampos(credencial, VETOR.campos)).toString('hex')).toBe(VETOR.dados_sas);
        expect(decodificarCampos(credencial, Buffer.from(VETOR.dados_sas, 'hex'))).toEqual(VETOR.campos);
    });
});

describe('campos', () => {
    it('ida e volta, com e sem replaces', () => {
        const { campos } = relatorio(3);
        expect(decodificarCampos(credencial, codificarCampos(credencial, campos))).toEqual(campos);
        const correcao = relatorio(9, { replaces: 3 }).campos;
        expect(decodificarCampos(credencial, codificarCampos(credencial, correcao))).toEqual(correcao);
    });

    it('layout em bytes: VecU8 e String com prefixo u32, U32, I64', () => {
        const { campos } = relatorio(258, { replaces: 5 });
        const b = Buffer.from(codificarCampos(credencial, campos));
        expect(b.readUInt32LE(0)).toBe(32);
        expect(b.subarray(4, 36).toString('hex')).toBe(campos.root);
        expect(b.readUInt32LE(36)).toBe(36);
        expect(b.subarray(40, 76).toString()).toBe(SERIE);
        expect(b.readUInt32LE(76)).toBe(258);
        expect(b.readBigInt64LE(80)).toBe(1_791_500_400n);
        expect(b.readUInt32LE(88)).toBe(6);
        expect(b.subarray(92, 98).toString()).toBe('2026.1');
        expect(b.readUInt32LE(98)).toBe(5);
        expect(b.length).toBe(102);
        expect(CAMPOS.map(([, t]) => t)).toEqual([13, 12, 2, 8, 12, 2]);
        expect(CAMPOS.map(([n]) => n)).toEqual(['root', 'series', 'number', 'issued_at', 'ruleset', 'replaces']);
    });

    it('bytes sobrando são recusados na leitura', () => {
        const b = codificarCampos(credencial, relatorio().campos);
        expect(() => decodificarCampos(credencial, Uint8Array.from([...b, 0]))).toThrow(/sobrando/);
    });
});

describe('validação da entrada', () => {
    const base = () => ({ schema: 'NT_RELATORIO', ...relatorio(4) });

    it('aceita o pedido correto', () => {
        expect(lerPedido(base()).campos.number).toBe(4);
        expect(lerPedido({ schema: 'NT_RELATORIO', ...relatorio(5, { replaces: 4 }) }).campos.replaces).toBe(4);
    });

    const casos: [string, (b: ReturnType<typeof base>) => unknown][] = [
        ['schema desconhecido', b => ({ ...b, schema: 'NT_LOTE' })],
        ['nonce maiúsculo', b => ({ ...b, nonce: b.nonce.toUpperCase() })],
        ['nonce curto', b => ({ ...b, nonce: 'ab' })],
        ['nonce de outro número', b => ({ ...b, nonce: nonceDoRelatorio(SERIE, 5) })],
        ['chave extra no corpo', b => ({ ...b, extra: 1 })],
        ['campo faltando', b => ({ ...b, campos: { ...b.campos, ruleset: undefined } })],
        ['campo sobrando', b => ({ ...b, campos: { ...b.campos, decision: 1 } })],
        ['root não hex', b => ({ ...b, campos: { ...b.campos, root: 'zz'.repeat(32) } })],
        ['root curto', b => ({ ...b, campos: { ...b.campos, root: 'ab' } })],
        ['série não UUID', b => ({ ...b, campos: { ...b.campos, series: 'abc' } })],
        ['série maiúscula', b => ({ ...b, campos: { ...b.campos, series: SERIE.toUpperCase() } })],
        ['número 0', b => ({ ...b, campos: { ...b.campos, number: 0 } })],
        ['número grande', b => ({ ...b, campos: { ...b.campos, number: 2 ** 32 } })],
        ['número texto', b => ({ ...b, campos: { ...b.campos, number: '4' } })],
        ['issued_at fracionário', b => ({ ...b, campos: { ...b.campos, issued_at: 1.5 } })],
        ['issued_at negativo', b => ({ ...b, campos: { ...b.campos, issued_at: -1 } })],
        ['ruleset vazio', b => ({ ...b, campos: { ...b.campos, ruleset: '' } })],
        ['ruleset com espaço', b => ({ ...b, campos: { ...b.campos, ruleset: 'v 1' } })],
        ['replaces = number', b => ({ ...b, campos: { ...b.campos, replaces: 4 } })],
        ['replaces > number', b => ({ ...b, campos: { ...b.campos, replaces: 9 } })],
        ['campos array', b => ({ ...b, campos: [] })],
    ];
    for (const [nome, mexer] of casos) {
        it(`recusa: ${nome}`, () => {
            const corpo = JSON.parse(JSON.stringify(mexer(base())));
            expect(() => lerPedido(corpo)).toThrow(ErroEntrada);
        });
    }
});

describe('validação da conta', () => {
    it('aceita a conta certa e recusa dono, discriminador, credencial, schema e nonce errados', async () => {
        const autoridade = (await generateKeyPairSigner()).address;
        const pdas = await derivarPdas(autoridade);
        const { nonce: hex, campos } = relatorio(2);
        const nonce = nonceDeHex(hex);
        const pda = await pdaAtestacao(pdas, nonce);
        const zero = getAddressDecoder().decode(new Uint8Array(32));
        const conta = (mudar: Partial<Parameters<ReturnType<typeof getAttestationEncoder>['encode']>[0]> = {}, dono: Address = PROGRAMA_SAS) =>
            ({
                address: pda,
                programAddress: dono,
                executable: false,
                lamports: 1n,
                space: 0n,
                data: new Uint8Array(
                    getAttestationEncoder().encode({
                        discriminator: 2,
                        nonce,
                        credential: pdas.credencial,
                        schema: pdas.schema,
                        data: codificarCampos(pdas.credencial, campos),
                        signer: autoridade,
                        expiry: 0,
                        tokenAccount: zero,
                        ...mudar,
                    }),
                ),
            }) as unknown as EncodedAccount;
        const esperado = { pdas, nonce };
        expect(validarConta(conta(), esperado).campos).toEqual(campos);
        expect(() => validarConta(conta({}, autoridade), esperado)).toThrow(ContaInvalida);
        expect(() => validarConta(conta({ discriminator: 1 }), esperado)).toThrow(/discriminador/);
        expect(() => validarConta(conta({ credential: autoridade }), esperado)).toThrow(/credencial/);
        expect(() => validarConta(conta({ schema: autoridade }), esperado)).toThrow(/schema/);
        expect(() => validarConta(conta({ nonce: autoridade }), esperado)).toThrow(/nonce/);
        expect(() => validarConta(conta({ data: new Uint8Array([1, 2, 3]) }), esperado)).toThrow(/layout/);
    });
});
