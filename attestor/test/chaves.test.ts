import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { carregarAssinante, cifrar, decifrar, envSenha, ErroCofre, gravarCofre, lerCofre, lerParSolanaCli, novoPar, senhaDe } from '../src/chaves.js';

const RAPIDO = { n: 2 ** 14, r: 8, p: 1 };
const SENHA = 'senha-de-teste-longa';

describe('cofre', () => {
    it('ida e volta, com o formato do contrato', async () => {
        const par = await novoPar();
        const esperado = (await createKeyPairSignerFromBytes(par)).address;
        const cofre = await cifrar(par, SENHA, RAPIDO);
        expect(Object.keys(cofre).sort()).toEqual(['cifra', 'endereco', 'iv', 'kdf', 'n', 'p', 'r', 'sal', 'tag', 'versao']);
        expect(cofre).toMatchObject({ versao: 1, kdf: 'scrypt', endereco: esperado });
        expect(cofre.cifra).not.toContain(Buffer.from(par).toString('hex').slice(0, 32));
        expect(Buffer.from(await decifrar(cofre, SENHA))).toEqual(Buffer.from(par));
    });

    it('senha errada falha', async () => {
        const cofre = await cifrar(await novoPar(), SENHA, RAPIDO);
        await expect(decifrar(cofre, 'outra-senha-longa')).rejects.toThrow(ErroCofre);
    });

    it('endereço trocado no arquivo falha (AAD)', async () => {
        const cofre = await cifrar(await novoPar(), SENHA, RAPIDO);
        const outro = await cifrar(await novoPar(), SENHA, RAPIDO);
        await expect(decifrar({ ...cofre, endereco: outro.endereco }, SENHA)).rejects.toThrow(ErroCofre);
    });

    it('parâmetros scrypt absurdos são recusados', async () => {
        const cofre = await cifrar(await novoPar(), SENHA, RAPIDO);
        await expect(decifrar({ ...cofre, n: 2 ** 30 }, SENHA)).rejects.toThrow(/scrypt/);
    });

    it('grava, não sobrescreve, carrega o assinante e importa do solana-cli', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nt-chaves-'));
        const par = await novoPar();
        const arquivo = join(dir, 'solana.json');
        writeFileSync(arquivo, JSON.stringify(Array.from(par)));
        const lido = lerParSolanaCli(readFileSync(arquivo, 'utf8'));
        gravarCofre('atestador', await cifrar(lido, SENHA, RAPIDO), dir);
        expect(() => gravarCofre('atestador', lerCofre('atestador', dir), dir)).toThrow(/já existe/);
        // O mesmo par em outro papel é recusado.
        expect(() => gravarCofre('autoridade', lerCofre('atestador', dir), dir)).toThrow(/já está no cofre atestador/);
        const s = await carregarAssinante('atestador', SENHA, dir);
        expect(s.address).toBe(lerCofre('atestador', dir).endereco);
        expect(() => lerParSolanaCli('[1,2,3]')).toThrow(ErroCofre);
    });
    it('a autoridade tem senha própria; o atestador usa NT_CHAVES_SENHA', () => {
        expect(envSenha('autoridade')).toBe('NT_CHAVES_SENHA_AUTORIDADE');
        expect(envSenha('atestador')).toBe('NT_CHAVES_SENHA');
        const env = { NT_CHAVES_SENHA: 'comum', NT_CHAVES_SENHA_AUTORIDADE: 'propria' };
        expect(senhaDe('autoridade', env)).toBe('propria');
        expect(senhaDe('atestador', env)).toBe('comum');
        expect(senhaDe('autoridade', { NT_CHAVES_SENHA: 'comum' })).toBeUndefined();
    });
});
