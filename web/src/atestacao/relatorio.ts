/**
 * O documento do relatório (NT_RELATORIO/1) e o registro dele na Solana (docs/atestacao/CONTRATO.md §2–§4): ler o
 * arquivo que a pessoa tem (o documento inteiro ou uma prova parcial), recalcular a raiz de Merkle e montar os campos que
 * a conta na rede tem de ter. Puro: sem rede e sem @solana/kit, para a página carregar isto antes do módulo da rede.
 *
 * O arquivo é dado não confiável: cada leitura confere a forma do que usa e diz o que não confere.
 */
import { sha256 } from '../sha256'
import { arvore, jcs, paraHex, raizPelaProva, type Item, type Passo } from './merkle'

export const PROGRAMA_SAS = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG'
export const NOME_CREDENCIAL = 'NODALTRACE'
export const NOME_SCHEMA = 'NT_RELATORIO'
export const VERSAO_SCHEMA = 1
/** Discriminadores das contas no SAS. */
export const DISCRIMINADOR_SCHEMA = 1
export const DISCRIMINADOR_ATESTACAO = 2
export const FORMATO = 'NT_RELATORIO/1'
export const FORMATO_PROVA = 'NT_RELATORIO_PROVA/1'

/** Códigos de tipo do SAS usados no schema. */
export const TIPO = { U32: 2, I64: 8, String: 12, VecU8: 13 } as const

/** Campos do schema NT_RELATORIO, na ordem do contrato (§4). */
export const LAYOUT = [
  ['root', TIPO.VecU8],
  ['series', TIPO.String],
  ['number', TIPO.U32],
  ['issued_at', TIPO.I64],
  ['ruleset', TIPO.String],
  ['replaces', TIPO.U32],
] as const

export interface CamposRelatorio {
  /** Raiz de Merkle do documento, em hex. */
  root: string
  series: string
  number: number
  /** `emitido_em` em segundos Unix. */
  issued_at: number
  /** Versão das regras. */
  ruleset: string
  /** Número do relatório substituído (0: nenhum). */
  replaces: number
}

export interface Cabecalho extends Item {
  formato: string
  relatorio: string
  serie: string
  numero: number
  emitido_em: string
  emissor: unknown
  regras: { versao: string; parametros?: unknown }
  bases: unknown[]
  analises: { id: string; nome: string; descricao?: string; base?: string }[]
  substitui: { relatorio: string; numero: number; motivo: string } | null
}

export interface ArquivoLido {
  tipo: 'documento' | 'prova'
  /** As folhas que o arquivo traz, na ordem do arquivo. */
  itens: Item[]
  cabecalho: Cabecalho
  /** A raiz recalculada das folhas (documento) ou pelas provas (prova parcial), em hex. */
  raiz: string
  /** O que não confere no arquivo em si (texto fora do JCS, prova que não fecha, raiz declarada diferente). */
  problemas: string[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Nonce da conta do relatório no SAS, em hex: sha256(utf8("NT_RELATORIO:" + série + ":" + número)) (§4). */
export const nonceDoRelatorio = (serie: string, numero: number) => sha256(`${NOME_SCHEMA}:${serie}:${numero}`)

function itensDe(obj: unknown): Item[] {
  const itens = (obj as { itens?: unknown } | null)?.itens
  if (!Array.isArray(itens) || !itens.length) throw new Error('The file has no leaves ("itens")')
  const vistos = new Set<string>()
  for (const i of itens) {
    if (!i || typeof i !== 'object' || typeof i.tipo !== 'string' || typeof i.id !== 'string') throw new Error('Leaf without "tipo" or "id"')
    const k = `${i.tipo}:${i.id}`
    if (vistos.has(k)) throw new Error(`Duplicate leaf: ${k}`)
    vistos.add(k)
  }
  return itens as Item[]
}

function cabecalhoDe(itens: Item[]): Cabecalho {
  const c = itens.find((i) => i.tipo === 'cabecalho' && i.id === 'cabecalho') as Cabecalho | undefined
  if (!c) throw new Error('The file has no report header')
  if (c.formato !== FORMATO) throw new Error(`Unknown format: ${String(c.formato)} (expected ${FORMATO})`)
  if (typeof c.relatorio !== 'string' || !UUID.test(String(c.serie)) || !Number.isSafeInteger(c.numero) || c.numero < 1)
    throw new Error('Header without a valid report number, series or id')
  if (Number.isNaN(Date.parse(String(c.emitido_em))) || typeof c.regras?.versao !== 'string') throw new Error('Header without issue date or rules version')
  if (c.substitui !== null && !(typeof c.substitui === 'object' && Number.isSafeInteger(c.substitui.numero)))
    throw new Error('Header with a malformed correction ("substitui")')
  return c
}

/**
 * Lê o arquivo baixado do NodalTrace: o documento do relatório (`{"itens": [...]}`, GET /relatorios/{id}/documento) ou
 * uma prova parcial (`{"formato": "NT_RELATORIO_PROVA/1", ...}`). Erro: o arquivo não é nenhum dos dois.
 */
export function lerArquivo(texto: string): ArquivoLido {
  let obj: unknown
  try {
    obj = JSON.parse(texto)
  } catch {
    throw new Error('The file is not JSON')
  }
  const itens = itensDe(obj)
  const cabecalho = cabecalhoDe(itens)
  const problemas: string[] = []
  const formato = (obj as { formato?: unknown }).formato

  if (formato === undefined) {
    // O documento inteiro: a raiz sai de todas as folhas.
    for (const tipo of ['resumo', 'imovel']) if (!itens.some((i) => i.tipo === tipo)) problemas.push(`The document has no "${tipo}" leaf`)
    if (jcs(obj) !== texto.trim()) problemas.push('The text is not in canonical form (JCS): the root is computed from the content, not the bytes')
    return { tipo: 'documento', itens, cabecalho, raiz: paraHex(arvore(itens).raiz), problemas }
  }
  if (formato !== FORMATO_PROVA) throw new Error(`Unknown format: ${String(formato)}`)

  // Prova parcial: cada folha sobe até a raiz pelos irmãos; todas têm de chegar à mesma.
  const provas = (obj as { provas?: unknown }).provas as Record<string, Passo[]> | undefined
  if (!provas || typeof provas !== 'object') throw new Error('The partial proof has no proof for each leaf')
  const raizes = new Set<string>()
  for (const i of itens) {
    const passos = provas[`${i.tipo}:${i.id}`]
    if (!Array.isArray(passos)) {
      problemas.push(`No proof for leaf ${i.tipo}:${i.id}`)
      continue
    }
    raizes.add(paraHex(raizPelaProva(i, passos)))
  }
  if (raizes.size > 1) problemas.push("The proof's leaves lead to different roots: one of them was altered")
  const [raiz] = raizes
  if (!raiz) throw new Error('No leaf of the proof could be checked')
  const declarada = (obj as { raiz?: unknown }).raiz
  if (typeof declarada === 'string' && declarada !== raiz) problemas.push('The root written in the file is not the one the leaves produce')
  return { tipo: 'prova', itens, cabecalho, raiz, problemas }
}

/** Os campos que a conta do relatório na rede tem de ter, a partir do arquivo (§4). */
export function camposEsperados(a: ArquivoLido): CamposRelatorio {
  const c = a.cabecalho
  return {
    root: a.raiz,
    series: c.serie,
    number: c.numero,
    issued_at: Math.floor(Date.parse(c.emitido_em) / 1000),
    ruleset: c.regras.versao,
    replaces: c.substitui ? c.substitui.numero : 0,
  }
}

/** Normaliza a saída do decodificador do SAS (VecU8 = number[], I64 = bigint) e confere a forma de cada campo. */
export function normalizarCampos(cru: Record<string, unknown>): CamposRelatorio {
  const root = cru.root
  if (!Array.isArray(root) || root.length !== 32 || root.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error('Invalid root field')
  const inteiro = (nome: string) => {
    const v = cru[nome]
    const n = typeof v === 'bigint' ? Number(v) : v
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${nome} field`)
    return n
  }
  const texto = (nome: string) => {
    if (typeof cru[nome] !== 'string') throw new Error(`Invalid ${nome} field`)
    return cru[nome] as string
  }
  return {
    root: paraHex(Uint8Array.from(root as number[])),
    series: texto('series'),
    number: inteiro('number'),
    issued_at: inteiro('issued_at'),
    ruleset: texto('ruleset'),
    replaces: inteiro('replaces'),
  }
}

export interface Conferencia {
  campo: keyof CamposRelatorio
  rotulo: string
  esperado: string | number
  lido: string | number | null
  ok: boolean
}

const ROTULOS: Record<keyof CamposRelatorio, string> = {
  root: 'Merkle root',
  series: 'Series',
  number: 'Number',
  issued_at: 'Issued at (Unix)',
  ruleset: 'Rules version',
  replaces: 'Supersedes number',
}

export function conferirCampos(esperado: CamposRelatorio, lido: CamposRelatorio | null): Conferencia[] {
  return LAYOUT.map(([campo]) => ({
    campo,
    rotulo: ROTULOS[campo],
    esperado: esperado[campo],
    lido: lido ? lido[campo] : null,
    ok: !!lido && lido[campo] === esperado[campo],
  }))
}

/** Acima disto (em segundos) entre a emissão declarada e o bloco do registro, a verificação avisa. */
export const ATRASO_MAXIMO_S = 600

/** Duração em minutos, horas ou dias. */
export function fmtDuracao(s: number): string {
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
    return m ? `${h} h ${m} min` : `${h} h`
  }
  const d = Math.floor(s / 86400)
  return d === 1 ? '1 day' : `${d} days`
}

/** O aviso para um bloco longe da emissão declarada (`issued_at`, na rede): a rede garante só que o documento existia
 *  no bloco; antes dele, vale a data que o NodalTrace declara. Sem a hora do bloco, ou perto dela, nada. */
export function avisoDeAtraso(issuedAt: number, blocoEm: string | null): string | null {
  if (!blocoEm) return null
  const atraso = Math.round(Date.parse(blocoEm) / 1000) - issuedAt
  if (atraso > ATRASO_MAXIMO_S)
    return `The registration came ${fmtDuracao(atraso)} after the declared issue time. The network guarantees the document existed at the block; before it, only the date NodalTrace declares applies.`
  if (atraso < -ATRASO_MAXIMO_S)
    return `The declared issue time is ${fmtDuracao(-atraso)} after the block: the NodalTrace server clock was ahead.`
  return null
}

/** Link do Solana Explorer (a mainnet não leva o parâmetro do cluster). */
export const urlExplorer = (tipo: 'address' | 'tx', valor: string, cluster: string | null | undefined) =>
  `https://explorer.solana.com/${tipo}/${encodeURIComponent(valor)}${cluster && cluster !== 'mainnet' && cluster !== 'mainnet-beta' ? `?cluster=${encodeURIComponent(cluster)}` : ''}`
