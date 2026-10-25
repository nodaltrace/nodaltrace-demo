/**
 * Onde o usuário está no painel. A URL é a fonte: cada tela tem um endereço que dá para recarregar, compartilhar e
 * percorrer com o voltar do navegador. O enquadramento do mapa fica no #zoom/lat/lon (map/hashMapa.ts), à parte.
 *
 *   /                    início
 *   /imovel/<código>     detalhe de um imóvel do CAR
 *   /selecao             seleção para análise: a lista de imóveis
 *   /selecao/analises    seleção para análise: as análises a aplicar
 *   /relatorio/<número>  relatório emitido
 */
export type Rota =
  | { tela: 'inicio' }
  | { tela: 'imovel'; cod: string }
  | { tela: 'selecao' }
  | { tela: 'analises' }
  | { tela: 'relatorio'; id: string }

export const INICIO: Rota = { tela: 'inicio' }

/** A rota de um caminho da URL; caminho desconhecido é o início. */
export function lerRota(caminho: string): Rota {
  const partes = caminho.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p)
    } catch {
      return p
    }
  })
  const [tela, arg, ...resto] = partes
  if (resto.length) return INICIO
  if (tela === 'imovel' && arg) return { tela: 'imovel', cod: arg.toUpperCase() }
  if (tela === 'relatorio' && arg) return { tela: 'relatorio', id: arg.toUpperCase() }
  if (tela === 'selecao') return arg === 'analises' ? { tela: 'analises' } : arg ? INICIO : { tela: 'selecao' }
  return INICIO
}

export function caminhoDe(r: Rota): string {
  switch (r.tela) {
    case 'inicio': return '/'
    case 'imovel': return `/imovel/${encodeURIComponent(r.cod)}`
    case 'selecao': return '/selecao'
    case 'analises': return '/selecao/analises'
    case 'relatorio': return `/relatorio/${encodeURIComponent(r.id)}`
  }
}

/** Na seleção para análise (as duas etapas e o relatório emitido) o painel mostra só a seleção. */
export const naAnalise = (r: Rota) => r.tela === 'selecao' || r.tela === 'analises' || r.tela === 'relatorio'
/** O clique no mapa inclui ou retira imóveis da seleção (nas duas etapas antes do relatório). */
export const montandoSelecao = (r: Rota) => r.tela === 'selecao' || r.tela === 'analises'
