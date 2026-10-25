// fundos: saldos das duas contas e airdrop da devnet (./run.sh solana).
//   saldos    saldo de cada conta; sai com 3 se alguma estiver abaixo do piso dela
//   airdrop   pede 1 SOL ao faucet do RPC para cada conta abaixo do piso
// As duas contas entram só como endereço (NT_AUTORIDADE e NT_ATESTADOR): nada aqui decifra chave nem envia
// transação. Nunca na mainnet, nem com NT_PERMITIR_MAINNET.
import { pathToFileURL } from 'node:url';
import { address, lamports, type Address, type Signature } from '@solana/kit';
import { json, noRpc } from './envio.js';
import { conferirRede, criarRpc, lerCluster, RPC_PADRAO, type Cluster, type RpcSolana } from './rede.js';

/** `atestador` paga a taxa e o aluguel de cada atestação; `autoridade`, os do setup (credencial e schema). */
export const CONTAS = ['atestador', 'autoridade'] as const;
export type Conta = (typeof CONTAS)[number];
export type Saldos = Record<Conta, bigint>;

const SOL = 1_000_000_000n;
export const AIRDROP = SOL;
/** O mesmo piso do servidor (NT_SALDO_MINIMO_LAMPORTS): abaixo dele o `atestador` não atesta. */
export const PISO_PADRAO = 50_000_000n;
/** O setup cria duas contas pequenas (aluguel de alguns milésimos de SOL); 0,02 SOL sobra. */
export const PISO_AUTORIDADE = 20_000_000n;

export const sol = (l: bigint) => `${(Number(l) / Number(SOL)).toFixed(6)} SOL`;

export function pisos(piso: bigint): Saldos {
    return { atestador: piso, autoridade: PISO_AUTORIDADE };
}

export async function lerSaldos(rpc: RpcSolana, enderecos: Record<Conta, Address>): Promise<Saldos> {
    const saldos = {} as Saldos;
    for (const c of CONTAS) {
        const { value } = await noRpc('getBalance', () => rpc.getBalance(enderecos[c], { commitment: 'confirmed' }).send());
        saldos[c] = value;
    }
    return saldos;
}

/** Espera o airdrop confirmar. O faucet não dá blockhash para a validade: prazo fixo. */
async function esperarAirdrop(rpc: RpcSolana, assinatura: Signature, prazoMs = 60_000): Promise<void> {
    const fim = Date.now() + prazoMs;
    while (Date.now() < fim) {
        const { value } = await noRpc('getSignatureStatuses', () => rpc.getSignatureStatuses([assinatura]).send());
        const st = value[0];
        if (st?.err) throw new Error(`airdrop falhou: ${json(st.err)}`);
        if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return;
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('airdrop não confirmou em 60 s');
}

/** Pede AIRDROP para cada conta abaixo do piso dela. Devolve as que ficaram acima dele. */
export async function airdrop(
    rpc: RpcSolana,
    cluster: Cluster,
    enderecos: Record<Conta, Address>,
    piso: bigint,
    log: (l: string) => void = console.log,
): Promise<Conta[]> {
    if (cluster === 'mainnet') throw new Error('airdrop só existe na devnet');
    const ok: Conta[] = [];
    const minimo = pisos(piso);
    for (const c of CONTAS) {
        const { value: saldo } = await noRpc('getBalance', () => rpc.getBalance(enderecos[c], { commitment: 'confirmed' }).send());
        if (saldo >= minimo[c]) {
            log(`${c.padEnd(10)} já tem ${sol(saldo)}; sem airdrop`);
            ok.push(c);
            continue;
        }
        try {
            const assinatura = await rpc.requestAirdrop(enderecos[c], lamports(AIRDROP), { commitment: 'confirmed' }).send();
            await esperarAirdrop(rpc, assinatura);
            log(`${c.padEnd(10)} recebeu ${sol(AIRDROP)} (${assinatura})`);
            ok.push(c);
        } catch (e) {
            // O faucet do RPC público tem limite por IP e por dia: falhar aqui é comum e não para o resto.
            log(`${c.padEnd(10)} airdrop recusado: ${(e as Error).message}`);
        }
    }
    return ok;
}

function enderecos(): Record<Conta, Address> {
    const env = (nome: string) => {
        const v = process.env[nome];
        if (!v) throw new Error(`${nome} não definido (o ./run.sh passa o endereço)`);
        return address(v);
    };
    return { atestador: env('NT_ATESTADOR'), autoridade: env('NT_AUTORIDADE') };
}

async function principal(): Promise<void> {
    const [cmd, ...resto] = process.argv.slice(2);
    if ((cmd !== 'saldos' && cmd !== 'airdrop') || resto.length) throw new Error('uso: fundos saldos | airdrop');
    const cluster = lerCluster(process.env.NT_SOLANA_CLUSTER);
    if (cluster === 'mainnet') throw new Error('fundos só na devnet ou na localnet');
    const rpcUrl = process.env.NT_SOLANA_RPC || RPC_PADRAO;
    const rpc = criarRpc(rpcUrl);
    await conferirRede(cluster, rpcUrl, rpc);
    const piso = BigInt(process.env.NT_SALDO_MINIMO_LAMPORTS || PISO_PADRAO);
    const end = enderecos();

    if (cmd === 'saldos') {
        const s = await lerSaldos(rpc, end);
        const minimo = pisos(piso);
        for (const c of CONTAS) console.log(`${c.padEnd(10)} ${end[c]}  ${sol(s[c])}${s[c] < minimo[c] ? `  (abaixo de ${sol(minimo[c])})` : ''}`);
        if (CONTAS.some(c => s[c] < minimo[c])) process.exitCode = 3;
    } else {
        const ok = await airdrop(rpc, cluster, end, piso);
        if (ok.length < CONTAS.length) process.exitCode = 3;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    principal().catch(e => {
        console.error(`fundos falhou: ${(e as Error).message}`);
        process.exit(1);
    });
}
