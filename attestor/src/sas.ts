// SAS (CONTRATO §4): credencial, schema NT_RELATORIO, PDAs, nonce, codificação dos campos e validação da conta.
import { createHash } from 'node:crypto';
import {
    getAttestationDataCodec,
    getAttestationDecoder,
    findAttestationPda,
    findCredentialPda,
    findSchemaPda,
    SchemaDataType,
    SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
    type Schema,
} from '@solana/attestation';
import { getAddressDecoder, type Address, type EncodedAccount } from '@solana/kit';

export const PROGRAMA_SAS = SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS;
export const NOME_CREDENCIAL = 'NODALTRACE';
export const NOME_SCHEMA = 'NT_RELATORIO';
export const VERSAO_SCHEMA = 1;
/** Discriminador da conta Attestation no programa SAS (Credential = 0, Schema = 1, Attestation = 2). */
export const DISCRIMINADOR_ATESTACAO = 2;

type Campo = readonly [nome: string, tipo: SchemaDataType];

/** Campos na ordem exata do §4. `root` é VecU8 de 32 bytes; `replaces` = 0 quando o relatório não substitui nenhum. */
export const CAMPOS: readonly Campo[] = [
    ['root', SchemaDataType.VecU8],
    ['series', SchemaDataType.String],
    ['number', SchemaDataType.U32],
    ['issued_at', SchemaDataType.I64],
    ['ruleset', SchemaDataType.String],
    ['replaces', SchemaDataType.U32],
];

export const DESCRICAO = 'NodalTrace: relatorio de analise (raiz Merkle do documento)';

/** Schema no formato do cliente (o que o programa grava), para o codec dos dados. */
export function schemaLocal(credencial: Address): Schema {
    return {
        discriminator: 1,
        credential: credencial,
        name: NOME_SCHEMA,
        description: DESCRICAO,
        layout: CAMPOS.map(([, t]) => t),
        fieldNames: CAMPOS.map(([n]) => n),
        isPaused: false,
        version: VERSAO_SCHEMA,
    };
}

// ---- PDAs e nonce ----

export type Pdas = { credencial: Address; schema: Address };

export async function derivarPdas(autoridade: Address): Promise<Pdas> {
    const [credencial] = await findCredentialPda({ authority: autoridade, name: NOME_CREDENCIAL });
    const [schema] = await findSchemaPda({ credential: credencial, name: NOME_SCHEMA, version: VERSAO_SCHEMA });
    return { credencial, schema };
}

/** Nonce do relatório (§4) em hex: sha256(utf8("NT_RELATORIO:" + série + ":" + número)). Uma conta por (série, número). */
export function nonceDoRelatorio(serie: string, numero: number): string {
    return createHash('sha256').update(`${NOME_SCHEMA}:${serie}:${numero}`, 'utf8').digest('hex');
}

/** Os 32 bytes do nonce, lidos como endereço. */
export function nonceDeHex(hex: string): Address {
    if (!HEX64.test(hex)) throw new ErroEntrada('nonce tem de ser hex de 64 caracteres minúsculos');
    return getAddressDecoder().decode(Buffer.from(hex, 'hex'));
}

export async function pdaAtestacao(pdas: Pdas, nonce: Address): Promise<Address> {
    const [pda] = await findAttestationPda({ credential: pdas.credencial, schema: pdas.schema, nonce });
    return pda;
}

// ---- Campos ----

export class ErroEntrada extends Error {}

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSAO_REGRAS = /^[0-9A-Za-z._-]{1,32}$/;
const U32_MAX = 0xffffffff;

/** Campos como trafegam no HTTP: `root` em hex, inteiros como número, textos como texto. */
export type Campos = { root: string; series: string; number: number; issued_at: number; ruleset: string; replaces: number };

function inteiro(v: unknown, nome: string, min: number, max: number): number {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
        throw new ErroEntrada(`${nome} tem de ser inteiro em [${min}, ${max}]`);
    }
    return v;
}

function texto(v: unknown, nome: string, formato: RegExp, descricao: string): string {
    if (typeof v !== 'string' || !formato.test(v)) throw new ErroEntrada(`${nome} tem de ser ${descricao}`);
    return v;
}

/** Valida os campos (chaves exatas, tipos, faixas, `replaces` < `number`) e devolve-os tipados. */
export function validarCampos(campos: unknown): Campos {
    if (typeof campos !== 'object' || campos === null || Array.isArray(campos)) throw new ErroEntrada('campos tem de ser objeto');
    const obj = campos as Record<string, unknown>;
    const esperados = CAMPOS.map(([n]) => n);
    const faltam = esperados.filter(k => !Object.hasOwn(obj, k));
    const sobram = Object.keys(obj).filter(k => !esperados.includes(k));
    if (faltam.length || sobram.length) {
        throw new ErroEntrada(`campos de ${NOME_SCHEMA}: faltam [${faltam.join(', ')}], sobram [${sobram.join(', ')}]`);
    }
    const c: Campos = {
        root: texto(obj.root, 'root', HEX64, 'hex de 64 caracteres minúsculos'),
        series: texto(obj.series, 'series', UUID, 'UUID minúsculo'),
        number: inteiro(obj.number, 'number', 1, U32_MAX),
        issued_at: inteiro(obj.issued_at, 'issued_at', 0, Number.MAX_SAFE_INTEGER),
        ruleset: texto(obj.ruleset, 'ruleset', VERSAO_REGRAS, 'a versão das regras (1 a 32 caracteres: letras, dígitos, . _ -)'),
        replaces: inteiro(obj.replaces, 'replaces', 0, U32_MAX),
    };
    if (c.replaces >= c.number) throw new ErroEntrada('replaces tem de ser menor que number (0 = não substitui)');
    return c;
}

function paraCodec(c: Campos): Record<string, unknown> {
    return { ...c, root: Array.from(Buffer.from(c.root, 'hex')), issued_at: BigInt(c.issued_at) };
}

/** Codifica os campos nos bytes da atestação. */
export function codificarCampos(credencial: Address, campos: unknown): Uint8Array {
    const codec = getAttestationDataCodec(schemaLocal(credencial));
    return new Uint8Array(codec.encode(paraCodec(validarCampos(campos)) as never));
}

/** Decodifica os bytes da atestação de volta para o formato HTTP; exige consumo total e faixas válidas. */
export function decodificarCampos(credencial: Address, dados: Uint8Array): Campos {
    const codec = getAttestationDataCodec(schemaLocal(credencial));
    const [bruto, fim] = codec.read(dados, 0);
    if (fim !== dados.length) throw new ErroEntrada('dados com bytes sobrando');
    const root = Uint8Array.from(bruto.root as number[]);
    if (root.length !== 32) throw new ErroEntrada('root com tamanho inválido');
    const emitido = bruto.issued_at as bigint;
    if (emitido < 0n || emitido > BigInt(Number.MAX_SAFE_INTEGER)) throw new ErroEntrada('issued_at fora da faixa');
    // Revalida pela mesma regra da entrada (UUID, faixas, replaces < number).
    return validarCampos({
        root: Buffer.from(root).toString('hex'),
        series: bruto.series,
        number: bruto.number,
        issued_at: Number(emitido),
        ruleset: bruto.ruleset,
        replaces: bruto.replaces,
    });
}

/** O nonce do pedido tem de ser o da regra (§4), calculado da série e do número dos campos. */
export function conferirNonce(nonce: string, campos: Campos): void {
    if (nonce !== nonceDoRelatorio(campos.series, campos.number)) throw new ErroEntrada('nonce não é o da série e do número');
}

// ---- Conta de atestação ----

export class ContaInvalida extends Error {}

export type AtestacaoLida = { pda: Address; campos: Campos; dados: Uint8Array; assinante: Address; expiry: bigint };

/**
 * Valida uma conta de atestação vinda do RPC (dado não confiável): dono = SAS, discriminador, nonce, credencial e
 * schema esperados, sem bytes sobrando, dados decodificáveis pelo layout.
 */
export function validarConta(conta: EncodedAccount, esperado: { pdas: Pdas; nonce: Address }): AtestacaoLida {
    if (conta.programAddress !== PROGRAMA_SAS) throw new ContaInvalida(`dono ${conta.programAddress} não é o SAS`);
    const bruto = new Uint8Array(conta.data);
    if (bruto.length < 1 || bruto[0] !== DISCRIMINADOR_ATESTACAO) throw new ContaInvalida('discriminador não é de atestação');
    let a;
    let fim: number;
    try {
        [a, fim] = getAttestationDecoder().read(bruto, 0);
    } catch {
        throw new ContaInvalida('conta não decodifica como atestação');
    }
    if (fim !== bruto.length) throw new ContaInvalida('conta com bytes sobrando');
    if (a.nonce !== esperado.nonce) throw new ContaInvalida('nonce diferente');
    if (a.credential !== esperado.pdas.credencial) throw new ContaInvalida('credencial diferente');
    if (a.schema !== esperado.pdas.schema) throw new ContaInvalida('schema diferente');
    const dados = new Uint8Array(a.data);
    let campos: Campos;
    try {
        campos = decodificarCampos(esperado.pdas.credencial, dados);
    } catch (e) {
        throw new ContaInvalida(`dados não seguem o layout: ${(e as Error).message}`);
    }
    return { pda: conta.address, campos, dados, assinante: a.signer, expiry: a.expiry };
}

/** O schema gravado na rede bate com o local (nome, layout, campos, versão, credencial)? */
export function schemaConfere(credencial: Address, naRede: Schema): boolean {
    const local = schemaLocal(credencial);
    return (
        naRede.credential === credencial &&
        naRede.name === NOME_SCHEMA &&
        naRede.version === VERSAO_SCHEMA &&
        JSON.stringify(naRede.layout) === JSON.stringify(local.layout) &&
        JSON.stringify(naRede.fieldNames) === JSON.stringify(local.fieldNames)
    );
}
