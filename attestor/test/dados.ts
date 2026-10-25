import { createHash } from 'node:crypto';
import { nonceDoRelatorio, type Campos } from '../src/sas.js';

export const h = (s: string) => createHash('sha256').update(s).digest('hex');

export const SERIE = '0b6f6d8e-6d1c-4e8b-9a35-3c1d2f8a9b10';

/** Campos de um relatório de teste e o nonce da regra (§4). */
export function relatorio(numero = 1, mudar: Partial<Campos> = {}): { nonce: string; campos: Campos } {
    const campos: Campos = {
        root: h(`raiz-${numero}`),
        series: SERIE,
        number: numero,
        issued_at: 1_791_500_400,
        ruleset: '2026.1',
        replaces: 0,
        ...mudar,
    };
    return { nonce: nonceDoRelatorio(campos.series, campos.number), campos };
}
