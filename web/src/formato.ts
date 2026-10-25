import type { Status } from './api/tipos'

// Demo do hackathon: tudo em inglês, com números e datas no formato dos EUA.
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

export const fmtNum = (n: number) => nf.format(n)

const df = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const dfAno = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
export const fmtData = (iso: string) => df.format(new Date(iso))
export const fmtDataAno = (iso: string) => dfAno.format(new Date(iso))
const dfAnoBrasilia = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Sao_Paulo' })
/** O dia de um instante (carregado_em, emitido_em) no horário de Brasília, como no PDF. */
export const fmtDiaBrasilia = (iso: string) => dfAnoBrasilia.format(new Date(iso))
/**
 * As três datas de uma base, que nunca são a do relatório: até onde vão os dados (tirada deles; `dados` diz o que ela
 * mede), a publicação na fonte, se informada na carga, e quando a base entrou no banco.
 */
export const fmtDatasBase = (b: { dados_ate: string | null; publicado_em: string | null; carregado_em: string }, dados = 'data') =>
  [
    b.dados_ate ? `${dados} through ${fmtDataAno(b.dados_ate)}` : 'no data date',
    b.publicado_em ? `published ${fmtDataAno(b.publicado_em)}` : null,
    `loaded ${fmtDiaBrasilia(b.carregado_em)}`,
  ].filter(Boolean).join(' · ')
const dfMes = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
export const fmtMesAno = (iso: string) => dfMes.format(new Date(iso))
/** 'Pampa' ou 'Atlantic Forest 62% · Pampa 38%': biomas do imóvel, do maior para o menor. */
export const fmtBiomas = (b: { nome: string; fracao: number }[]) =>
  b.length === 0 ? 'Outside the IBGE biomes' : b.length === 1 ? b[0].nome : b.map((x) => `${x.nome} ${Math.round(x.fracao * 100)}%`).join(' · ')

/** Hectares com uma casa decimal: alertas costumam ter poucos hectares. */
export const fmtHa = (ha: number | null) => (ha == null ? 'area not reported' : `${nf1.format(ha)} ha`)

export interface StatusMeta {
  rotulo: string
  cor: string
  icone: 'circulo' | 'triangulo' | 'losango' | 'anel'
}

/** Rótulo, cor e forma de cada status que a API devolve. */
export const STATUS: Record<Status, StatusMeta> = {
  conforme: { rotulo: 'Compliant', cor: '#5A9270', icone: 'circulo' },
  atencao: { rotulo: 'Attention', cor: '#C99A3E', icone: 'triangulo' },
  nao_conforme: { rotulo: 'Non-compliant', cor: '#C4574A', icone: 'losango' },
  pendente: { rotulo: 'Pending', cor: '#8A939D', icone: 'anel' },
}

export const ORDEM_STATUS: Status[] = ['nao_conforme', 'atencao', 'pendente', 'conforme']
