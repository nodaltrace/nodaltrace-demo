// Cofre de chaves (CONTRATO §8): um arquivo por chave em chaves/<nome>.json,
// {"versao": 1, "kdf": "scrypt", "n", "r", "p", "sal", "iv", "tag", "cifra", "endereco"}, scrypt + AES-256-GCM.
// Binários em hex. A cifra é o par de 64 bytes no formato do solana-cli (semente ‖ chave pública). O endereço vai em
// claro e também como AAD do GCM: trocar o endereço do arquivo invalida a tag.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    createKeyPairSignerFromBytes,
    createKeyPairSignerFromPrivateKeyBytes,
    getAddressEncoder,
    getBase58Encoder,
    type KeyPairSigner,
} from '@solana/kit';

export type Cofre = {
    versao: 1;
    kdf: 'scrypt';
    n: number;
    r: number;
    p: number;
    sal: string;
    iv: string;
    tag: string;
    cifra: string;
    endereco: string;
};

export type ParametrosScrypt = { n: number; r: number; p: number };

export const SCRYPT_PADRAO: ParametrosScrypt = { n: 2 ** 17, r: 8, p: 1 };
export const NOMES_CHAVES = ['autoridade', 'atestador'] as const;

export class ErroCofre extends Error {}

/**
 * Env da senha de cada cofre: `autoridade` tem senha própria (NT_CHAVES_SENHA_AUTORIDADE), que só o setup recebe;
 * o `atestador` usa NT_CHAVES_SENHA. O servidor nunca vê a senha nem o cofre da autoridade.
 */
export function envSenha(nome: string): 'NT_CHAVES_SENHA' | 'NT_CHAVES_SENHA_AUTORIDADE' {
    return nome === 'autoridade' ? 'NT_CHAVES_SENHA_AUTORIDADE' : 'NT_CHAVES_SENHA';
}

export function senhaDe(nome: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    return env[envSenha(nome)];
}

const NOME_VALIDO = /^[a-z][a-z0-9_-]{0,31}$/;

export function dirChaves(env: NodeJS.ProcessEnv = process.env): string {
    return resolve(env.NT_CHAVES_DIR ?? join(process.cwd(), 'chaves'));
}

export function caminhoCofre(nome: string, dir = dirChaves()): string {
    if (!NOME_VALIDO.test(nome)) throw new ErroCofre(`nome de chave inválido: ${nome}`);
    return join(dir, `${nome}.json`);
}

function derivar(senha: string, sal: Buffer, { n, r, p }: ParametrosScrypt): Buffer {
    // Limites: evita que um arquivo adulterado peça memória/tempo absurdos.
    if (!Number.isInteger(n) || n < 2 ** 14 || n > 2 ** 20 || (n & (n - 1)) !== 0) throw new ErroCofre('scrypt n fora do aceito');
    if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) throw new ErroCofre('scrypt r/p fora do aceito');
    return scryptSync(senha.normalize('NFC'), sal, 32, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 });
}

function exigirSenha(senha: string | undefined): string {
    if (!senha || senha.length < 12) throw new ErroCofre('senha do cofre ausente ou curta (mínimo 12 caracteres)');
    return senha;
}

/** Cifra um par de 64 bytes (semente ‖ pública) e devolve o cofre. Confere que a pública bate com a semente. */
export async function cifrar(par: Uint8Array, senha: string, params: ParametrosScrypt = SCRYPT_PADRAO): Promise<Cofre> {
    exigirSenha(senha);
    if (par.length !== 64) throw new ErroCofre('o par tem de ter 64 bytes');
    const signer = await createKeyPairSignerFromBytes(par); // valida semente × pública
    const sal = randomBytes(16);
    const iv = randomBytes(12);
    const chave = derivar(senha, sal, params);
    const c = createCipheriv('aes-256-gcm', chave, iv);
    c.setAAD(Buffer.from(signer.address, 'utf8'));
    const cifra = Buffer.concat([c.update(par), c.final()]);
    chave.fill(0);
    return {
        versao: 1,
        kdf: 'scrypt',
        ...params,
        sal: sal.toString('hex'),
        iv: iv.toString('hex'),
        tag: c.getAuthTag().toString('hex'),
        cifra: cifra.toString('hex'),
        endereco: signer.address,
    };
}

function hexBuf(v: unknown, bytes: number, campo: string): Buffer {
    if (typeof v !== 'string' || !/^[0-9a-f]*$/.test(v) || v.length !== bytes * 2) throw new ErroCofre(`campo ${campo} inválido`);
    return Buffer.from(v, 'hex');
}

/** Decifra e devolve o par de 64 bytes. Senha errada ou arquivo adulterado: ErroCofre. */
export async function decifrar(cofre: Cofre, senha: string): Promise<Uint8Array> {
    exigirSenha(senha);
    if (cofre?.versao !== 1 || cofre.kdf !== 'scrypt') throw new ErroCofre('cofre de versão desconhecida');
    const sal = hexBuf(cofre.sal, 16, 'sal');
    const iv = hexBuf(cofre.iv, 12, 'iv');
    const tag = hexBuf(cofre.tag, 16, 'tag');
    const cifra = hexBuf(cofre.cifra, 64, 'cifra');
    const chave = derivar(senha, sal, cofre);
    const d = createDecipheriv('aes-256-gcm', chave, iv);
    d.setAAD(Buffer.from(String(cofre.endereco), 'utf8'));
    d.setAuthTag(tag);
    let par: Buffer;
    try {
        par = Buffer.concat([d.update(cifra), d.final()]);
    } catch {
        throw new ErroCofre('senha errada ou cofre adulterado');
    } finally {
        chave.fill(0);
    }
    const signer = await createKeyPairSignerFromBytes(par);
    if (signer.address !== cofre.endereco) throw new ErroCofre('endereço do cofre não bate com a chave');
    return new Uint8Array(par);
}

/** Par novo de 64 bytes (semente aleatória ‖ pública). */
export async function novoPar(): Promise<Uint8Array> {
    const semente = randomBytes(32);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(semente);
    const par = new Uint8Array(64);
    par.set(semente, 0);
    par.set(getAddressEncoder().encode(signer.address), 32);
    semente.fill(0);
    return par;
}

/** Lê um arquivo do solana-cli (JSON com 64 números). */
export function lerParSolanaCli(texto: string): Uint8Array {
    let v: unknown;
    try {
        v = JSON.parse(texto);
    } catch {
        throw new ErroCofre('arquivo não é JSON');
    }
    if (!Array.isArray(v) || v.length !== 64 || !v.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) {
        throw new ErroCofre('esperado um array JSON de 64 bytes (formato do solana-cli)');
    }
    return Uint8Array.from(v as number[]);
}

export function lerCofre(nome: string, dir = dirChaves()): Cofre {
    const caminho = caminhoCofre(nome, dir);
    if (!existsSync(caminho)) throw new ErroCofre(`cofre ${nome} não existe em ${dir}`);
    return JSON.parse(readFileSync(caminho, 'utf8')) as Cofre;
}

export function gravarCofre(nome: string, cofre: Cofre, dir = dirChaves()): string {
    const caminho = caminhoCofre(nome, dir);
    if (existsSync(caminho)) throw new ErroCofre(`cofre ${nome} já existe; não sobrescrevo`);
    // Cada papel com o seu par: a mesma chave nos dois cofres levaria a autoridade ao servidor.
    const enderecoDe = (arquivo: string): unknown => {
        try {
            return (JSON.parse(readFileSync(join(dir, arquivo), 'utf8')) as Partial<Cofre> | null)?.endereco;
        } catch {
            return undefined; // não é um cofre
        }
    };
    const repetido = existsSync(dir) ? readdirSync(dir).find(a => a.endsWith('.json') && enderecoDe(a) === cofre.endereco) : undefined;
    if (repetido) throw new ErroCofre(`o par de ${nome} já está no cofre ${repetido.replace(/\.json$/, '')}; use um par diferente para cada conta`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(caminho, JSON.stringify(cofre, null, 1) + '\n', { mode: 0o600, flag: 'wx' });
    return caminho;
}

/** Abre um cofre e devolve o assinante (chave em memória, não extraível). */
export async function carregarAssinante(nome: string, senha: string | undefined, dir = dirChaves()): Promise<KeyPairSigner> {
    const par = await decifrar(lerCofre(nome, dir), exigirSenha(senha));
    try {
        return await createKeyPairSignerFromBytes(par);
    } finally {
        par.fill(0);
    }
}

/**
 * Assinante a partir do par de 64 bytes em base58 (NT_CHAVE_ATESTADOR, usada na nuvem: lá o Cloud KMS decifra na
 * subida, em deploy/kms-exec, e não há cofre nem senha). Confere que a pública bate com a semente.
 */
export async function assinanteDeSegredo(base58: string): Promise<KeyPairSigner> {
    let par: Uint8Array;
    try {
        par = Uint8Array.from(getBase58Encoder().encode(base58.trim()));
    } catch {
        throw new ErroCofre('chave em base58 inválida');
    }
    try {
        if (par.length !== 64) throw new ErroCofre('a chave tem de ter 64 bytes');
        return await createKeyPairSignerFromBytes(par);
    } finally {
        par.fill(0);
    }
}
