// setup: cria (idempotente) a credencial NODALTRACE e o schema NT_RELATORIO, e deixa o `atestador` como o único
// assinante autorizado da credencial (com outro atestador, troca: é assim que se substitui uma chave vazada).
// Autoridade = chave `autoridade` (só aqui), que também paga a taxa e o aluguel. Com --confirmar decifra só a
// `autoridade` (senha NT_CHAVES_SENHA_AUTORIDADE). Sem --confirmar, só mostra o plano e a simulação; nunca envia, e
// não precisa de senha: os endereços vêm do campo `endereco` (em claro) dos cofres e a simulação usa assinantes vazios
// (sigVerify desligado).
import { pathToFileURL } from 'node:url';
import {
    decodeCredential,
    decodeSchema,
    getChangeAuthorizedSignersInstruction,
    getCreateCredentialInstruction,
    getCreateSchemaInstruction,
    getCredentialEncoder,
    getSchemaEncoder,
} from '@solana/attestation';
import { address, createNoopSigner, fetchEncodedAccounts, type Instruction, type TransactionSigner } from '@solana/kit';
import { carregarAssinante, lerCofre, senhaDe } from './chaves.js';
import { confirmar, enviarDireto, json, montarEAssinar, noRpc, simular, ultimoBlockhash } from './envio.js';
import { conferirRede, criarRpc, lerCluster, RPC_PADRAO, urlPublica, type Cluster, type RpcSolana } from './rede.js';
import { CAMPOS, DESCRICAO, derivarPdas, NOME_CREDENCIAL, NOME_SCHEMA, PROGRAMA_SAS, schemaConfere, schemaLocal, VERSAO_SCHEMA } from './sas.js';

export type OpcoesSetup = {
    rpc: RpcSolana;
    rpcUrl: string;
    cluster: Cluster;
    /** Com `confirmar`, assinante de verdade; sem, basta um assinante vazio (createNoopSigner). */
    autoridade: TransactionSigner;
    /** Só o endereço: o assinante autorizado que a credencial deve ter. */
    atestador: TransactionSigner;
    confirmar: boolean;
    log?: (linha: string) => void;
};

export type ResultadoSetup = {
    criar: string[];
    simulacaoOk: boolean | null;
    enviado: boolean;
    assinatura?: string;
};

const SOL = 1_000_000_000;
const sol = (l: bigint | number) => `${(Number(l) / SOL).toFixed(6)} SOL`;

export async function setup(o: OpcoesSetup): Promise<ResultadoSetup> {
    const log = o.log ?? console.log;
    const pdas = await derivarPdas(o.autoridade.address);
    log(`cluster        ${o.cluster}`);
    log(`rpc            ${urlPublica(o.rpcUrl)}`);
    log(`programa SAS   ${PROGRAMA_SAS}`);
    log(`autoridade     ${o.autoridade.address} (paga aluguel e taxa)`);
    log(`atestador      ${o.atestador.address}`);
    log(`credencial     ${pdas.credencial} (${NOME_CREDENCIAL})`);
    log(`schema         ${pdas.schema} (${NOME_SCHEMA} v${VERSAO_SCHEMA})`);

    const [cred, schema] = await noRpc('getMultipleAccounts', () =>
        fetchEncodedAccounts(o.rpc, [pdas.credencial, pdas.schema], { commitment: 'confirmed' }),
    );
    const instrucoes: Instruction[] = [];
    const criar: string[] = [];
    let aluguelTotal = 0n;
    const aluguelDe = (tamanho: number) =>
        noRpc('getMinimumBalanceForRentExemption', () => o.rpc.getMinimumBalanceForRentExemption(BigInt(tamanho)).send());

    if (cred.exists) {
        if (cred.programAddress !== PROGRAMA_SAS) throw new Error('a PDA da credencial existe com outro dono');
        const c = decodeCredential(cred).data;
        if (c.authority !== o.autoridade.address) throw new Error('credencial com outra autoridade');
        if (c.authorizedSigners.length === 1 && c.authorizedSigners[0] === o.atestador.address) {
            log(`credencial já existe; assinante autorizado: ${o.atestador.address}`);
        } else {
            criar.push('assinantes');
            log(`trocar os assinantes da credencial: ${c.authorizedSigners.join(', ') || '(nenhum)'} → ${o.atestador.address}`);
            instrucoes.push(
                getChangeAuthorizedSignersInstruction({
                    payer: o.autoridade,
                    authority: o.autoridade,
                    credential: pdas.credencial,
                    signers: [o.atestador.address],
                }),
            );
        }
    } else {
        const tamanho = getCredentialEncoder().encode({
            discriminator: 0,
            authority: o.autoridade.address,
            name: new TextEncoder().encode(NOME_CREDENCIAL),
            authorizedSigners: [o.atestador.address],
        }).length;
        const aluguel = await aluguelDe(tamanho);
        aluguelTotal += aluguel;
        criar.push('credencial');
        log(`criar credencial: ${tamanho} bytes, aluguel ${sol(aluguel)}; assinante autorizado ${o.atestador.address} (atestador)`);
        instrucoes.push(
            getCreateCredentialInstruction({
                payer: o.autoridade,
                credential: pdas.credencial,
                authority: o.autoridade,
                name: NOME_CREDENCIAL,
                signers: [o.atestador.address],
            }),
        );
    }

    if (schema.exists) {
        if (schema.programAddress !== PROGRAMA_SAS) throw new Error(`a PDA do schema ${NOME_SCHEMA} existe com outro dono`);
        if (!schemaConfere(pdas.credencial, decodeSchema(schema).data)) {
            throw new Error(`schema ${NOME_SCHEMA} existe na rede com layout diferente do CONTRATO §4`);
        }
        log(`schema ${NOME_SCHEMA} já existe e confere`);
    } else {
        const tamanho = getSchemaEncoder().encode(schemaLocal(pdas.credencial)).length;
        const aluguel = await aluguelDe(tamanho);
        aluguelTotal += aluguel;
        criar.push(NOME_SCHEMA);
        log(`criar schema ${NOME_SCHEMA}: ${tamanho} bytes, aluguel ${sol(aluguel)}; campos ${CAMPOS.map(([n, t]) => `${n}:${t}`).join(' ')}`);
        instrucoes.push(
            getCreateSchemaInstruction({
                payer: o.autoridade,
                authority: o.autoridade,
                credential: pdas.credencial,
                schema: pdas.schema,
                name: NOME_SCHEMA,
                description: DESCRICAO,
                layout: CAMPOS.map(([, t]) => t),
                fieldNames: CAMPOS.map(([n]) => n),
            }),
        );
    }

    if (!instrucoes.length) {
        log('nada a criar.');
        return { criar, simulacaoOk: null, enviado: false };
    }

    const { value: saldo } = await noRpc('getBalance', () => o.rpc.getBalance(o.autoridade.address, { commitment: 'confirmed' }).send());
    log(`aluguel estimado ${sol(aluguelTotal)}; saldo da autoridade ${sol(saldo)}`);

    const vida = await ultimoBlockhash(o.rpc);
    const tx = await montarEAssinar(o.autoridade, instrucoes, vida, !o.confirmar);
    const sim = await simular(o.rpc, tx);
    log(`simulação: ${sim.ok ? 'ok' : `FALHOU ${json(sim.erro)}`}; unidades ${sim.unidades ?? '?'}`);
    for (const l of sim.logs) log(`  ${l}`);

    if (!sim.ok) return { criar, simulacaoOk: false, enviado: false };
    if (!o.confirmar) {
        log('somente plano e simulação. Para enviar: setup --confirmar');
        return { criar, simulacaoOk: true, enviado: false };
    }
    const assinatura = await enviarDireto(o.rpc, tx);
    log(`enviada ${assinatura}; aguardando confirmação…`);
    const slot = await confirmar(o.rpc, assinatura, vida);
    log(`confirmada no slot ${slot}`);
    return { criar, simulacaoOk: true, enviado: true, assinatura };
}

async function principal(): Promise<void> {
    const args = process.argv.slice(2);
    const desconhecidos = args.filter(a => a !== '--confirmar');
    if (desconhecidos.length) throw new Error(`argumentos desconhecidos: ${desconhecidos.join(' ')} (uso: setup [--confirmar])`);
    const cluster = lerCluster(process.env.NT_SOLANA_CLUSTER);
    const rpcUrl = process.env.NT_SOLANA_RPC || RPC_PADRAO;
    const rpc = criarRpc(rpcUrl);
    await conferirRede(cluster, rpcUrl, rpc);
    const confirmar = args.includes('--confirmar');
    // O atestador só entra como endereço (assinante autorizado da credencial): nunca é decifrado aqui. Vem de
    // NT_ATESTADOR (o ./run.sh não monta o cofre dele no setup) ou, fora do compose, do campo `endereco` do cofre.
    const atestador = createNoopSigner(address(process.env.NT_ATESTADOR || lerCofre('atestador').endereco));
    const autoridade = confirmar
        ? await carregarAssinante('autoridade', senhaDe('autoridade'))
        : createNoopSigner(address(lerCofre('autoridade').endereco));
    delete process.env.NT_CHAVES_SENHA_AUTORIDADE;
    const r = await setup({ rpc, rpcUrl, cluster, autoridade, atestador, confirmar });
    console.log(`\nNT_AUTORIDADE=${autoridade.address}`);
    if (r.simulacaoOk === false) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    principal().catch(e => {
        console.error(`setup falhou: ${(e as Error).message}`);
        process.exit(1);
    });
}
