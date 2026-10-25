// Rede: qual cluster, qual RPC, e a trava contra mainnet.
//
// Regra (CONTRATO §0, devnet só): o cluster declarado em NT_SOLANA_CLUSTER tem de bater com a rede do RPC.
// - devnet: o genesis hash do RPC tem de ser o da devnet.
// - localnet: o host do RPC tem de ser loopback (ou listado em NT_LOCALNET_HOSTS). Não se confere o genesis, porque o
//   Surfpool bifurca a mainnet e pode reportar o genesis dela; nada sai da máquina.
// - mainnet: recusada, a menos que NT_PERMITIR_MAINNET=sim; e mesmo assim o genesis tem de ser o da mainnet.
// Qualquer RPC cujo genesis seja o da mainnet com cluster ≠ mainnet é recusado.
import { createSolanaRpc, type Rpc, type SolanaRpcApi } from '@solana/kit';

export type Cluster = 'devnet' | 'localnet' | 'mainnet';
export type RpcSolana = Rpc<SolanaRpcApi>;

export const GENESIS = {
    devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;

export const RPC_PADRAO = 'https://api.devnet.solana.com';

export class RedeRecusada extends Error {}

export function lerCluster(valor: string | undefined): Cluster {
    const c = (valor ?? 'devnet').trim();
    if (c !== 'devnet' && c !== 'localnet' && c !== 'mainnet') throw new RedeRecusada(`cluster desconhecido: ${c}`);
    return c;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Checagem estática (sem rede): URL, esquema e host. */
export function conferirUrl(cluster: Cluster, url: string, env: NodeJS.ProcessEnv = process.env): void {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        throw new RedeRecusada('NT_SOLANA_RPC inválida');
    }
    if (cluster === 'mainnet' && env.NT_PERMITIR_MAINNET !== 'sim') {
        throw new RedeRecusada('mainnet recusada (defina NT_PERMITIR_MAINNET=sim para liberar)');
    }
    if (cluster !== 'mainnet' && /mainnet/i.test(u.hostname)) {
        throw new RedeRecusada(`RPC de mainnet com cluster ${cluster}`);
    }
    if (cluster === 'localnet') {
        const extras = (env.NT_LOCALNET_HOSTS ?? '').split(',').map(s => s.trim()).filter(Boolean);
        if (!LOOPBACK.has(u.hostname) && !extras.includes(u.hostname)) {
            throw new RedeRecusada(`localnet exige RPC local (host ${u.hostname})`);
        }
    } else if (u.protocol !== 'https:') {
        throw new RedeRecusada('RPC externo só por HTTPS');
    }
}

/** Checagem dinâmica: pergunta o genesis ao RPC. */
export async function conferirRede(cluster: Cluster, url: string, rpc: RpcSolana, env = process.env): Promise<void> {
    conferirUrl(cluster, url, env);
    if (cluster === 'localnet') return;
    const genesis = await rpc.getGenesisHash().send();
    if (genesis === GENESIS.mainnet && cluster !== 'mainnet') throw new RedeRecusada('o RPC é da mainnet');
    if (genesis !== GENESIS[cluster]) throw new RedeRecusada(`genesis ${genesis} não é o da ${cluster}`);
}

export function criarRpc(url: string): RpcSolana {
    return createSolanaRpc(url);
}

/** Só esquema e host (provedores põem a chave no caminho ou na query), para /saude e logs. */
export function urlPublica(url: string): string {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}`;
    } catch {
        return '?';
    }
}
