import type { CasoMapbiomas, ImagensImovel, OpcaoImagemInpe, OpcaoImagemMapbiomas } from '../api/tipos'
import { fmtDataAno } from '../formato'

/** Fontes de imagem histórica de um imóvel do CAR (GET /car/{cod}/imagens?fonte=…). */
export type FonteHistorica = 'mapbiomas' | 'cbers4a' | 'sentinel2'

/** Na ordem do menu. `detalhe`: resolução no terreno e, no MapBiomas, o aviso de "beta". */
const TODAS: { id: FonteHistorica; nome: string; detalhe: string }[] = [
  { id: 'mapbiomas', nome: 'MapBiomas', detalhe: '~3 m · beta' },
  { id: 'cbers4a', nome: 'CBERS-4A', detalhe: '2 m' },
  { id: 'sentinel2', nome: 'Sentinel-2', detalhe: '10 m' },
]

/** Demo do hackathon: só as imagens dos alertas do MapBiomas. A API da demo recusa as do INPE (NT_SEM_INPE). */
export const FONTES_HISTORICAS = TODAS.filter((f) => f.id === 'mapbiomas')

export const NOME_FONTE: Record<FonteHistorica, string> = Object.fromEntries(TODAS.map((f) => [f.id, f.nome])) as Record<FonteHistorica, string>

const CHAVE = 'nodaltrace:fonte-historica'

/** A escolha deste navegador; sem ela (ou com uma fonte desligada na demo), o MapBiomas. */
export function fonteHistoricaSalva(): FonteHistorica {
  let salvo: string | null = null
  try { salvo = localStorage.getItem(CHAVE) } catch { /* armazenamento indisponível */ }
  return FONTES_HISTORICAS.some((f) => f.id === salvo) ? (salvo as FonteHistorica) : 'mapbiomas'
}

export function salvarFonteHistorica(fonte: FonteHistorica) {
  try { localStorage.setItem(CHAVE, fonte) } catch { /* vale até recarregar */ }
}

/** O que está escolhido para comparar, já com as datas sugeridas pela API no lugar das que o usuário não escolheu. */
export type Escolha =
  | { tipo: 'inpe'; antes: OpcaoImagemInpe; depois: OpcaoImagemInpe }
  | { tipo: 'mapbiomas'; alerta: OpcaoImagemMapbiomas; caso: CasoMapbiomas }

/** A escolha do usuário quando ela está na listagem; senão, a sugestão da API (GET /car/{cod}/imagens → `sugestao`). */
export function resolverEscolha(dados: ImagensImovel, c: { antes: string | null; depois: string | null } | null): Escolha | null {
  if (dados.fonte === 'mapbiomas') {
    const alerta = dados.opcoes.find((o) => o.id === c?.antes) ?? dados.opcoes.find((o) => o.id === dados.sugestao.alerta)
    return alerta ? { tipo: 'mapbiomas', alerta, caso: alerta.caso } : null
  }
  const porId = (id: string | null | undefined) => dados.opcoes.find((o) => o.id === id)
  const antes = porId(c?.antes) ?? porId(dados.sugestao?.antes)
  const depois = porId(c?.depois) ?? porId(dados.sugestao?.depois)
  return antes && depois ? { tipo: 'inpe', antes, depois } : null
}

/** Dá para abrir a comparação: duas datas do INPE, ou um alerta do MapBiomas com imagem. */
export const comparavel = (e: Escolha | null) => !!e && (e.tipo === 'inpe' || e.caso !== 'sem-imagem')

/** 2023-04-29 → Apr 29, 2023: o dia como está escrito, sem fuso. O que não for uma data passa como veio. */
export const fmtDia = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? fmtDataAno(iso.slice(0, 10)) : iso)

/** Por que a imagem do INPE saiu com resolução pior que a da fonte (cabeçalho `X-Reducao`). */
const MOTIVO_REDUCAO: Record<string, string> = {
  'defeito-inpe': 'reduced resolution: defective INPE file in this area',
  tamanho: 'reduced resolution due to the property size',
}

/** Resolução na legenda, só quando a imagem saiu pior que a fonte: "20 m (reduced resolution: …)". */
export function notaResolucao(metros: number | null, reducao: string | null): string | null {
  if (!reducao || metros === null) return null
  return `${metros.toLocaleString('en-US')} m (${MOTIVO_REDUCAO[reducao] ?? 'reduced resolution'})`
}
