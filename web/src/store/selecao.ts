import { create } from 'zustand'

/** Limite de imóveis por relatório (o mesmo da API). */
export const MAX_IMOVEIS_ANALISE = 200

const CHAVE = 'nodaltrace:selecao'
const CHAVE_CORRECAO = 'nodaltrace:correcao'

/** A correção em curso: o relatório que o próximo vai substituir e as análises dele, para já virem marcadas. */
export interface Correcao {
  relatorio: string
  analises: string[]
}

/** A lista guardada neste navegador: recarregar a página não a perde (só conveniência de quem vê). */
function salva(): string[] {
  try {
    const l = JSON.parse(localStorage.getItem(CHAVE) ?? '[]')
    return Array.isArray(l) ? l.filter((c) => typeof c === 'string').slice(0, MAX_IMOVEIS_ANALISE) : []
  } catch {
    return []
  }
}

function salvar(imoveis: string[]) {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(imoveis))
  } catch {
    // sem armazenamento: a lista vale só até recarregar
  }
}

function correcaoSalva(): Correcao | null {
  try {
    const c = JSON.parse(localStorage.getItem(CHAVE_CORRECAO) ?? 'null')
    return c && typeof c.relatorio === 'string' && Array.isArray(c.analises) ? { relatorio: c.relatorio, analises: c.analises.filter((a: unknown) => typeof a === 'string') } : null
  } catch {
    return null
  }
}

function salvarCorrecao(c: Correcao | null) {
  try {
    if (c) localStorage.setItem(CHAVE_CORRECAO, JSON.stringify(c))
    else localStorage.removeItem(CHAVE_CORRECAO)
  } catch {
    // sem armazenamento: a correção vale só até recarregar
  }
}

/** A seleção para análise: os códigos do CAR escolhidos, na ordem em que entraram, e a correção em curso. */
interface EstadoSelecao {
  imoveis: string[]
  correcao: Correcao | null
  /** Inclui o imóvel ou, se já está na lista, retira; acima do limite, não inclui. */
  alternar: (cod: string) => void
  /** Começa a correção de um relatório: a lista passa a ser a dele. */
  corrigir: (relatorio: string, imoveis: string[], analises: string[]) => void
  cancelarCorrecao: () => void
  /** Esvazia a lista e encerra a correção em curso. */
  limpar: () => void
}

export const useSelecao = create<EstadoSelecao>((set) => ({
  imoveis: salva(),
  correcao: correcaoSalva(),
  alternar: (cod) =>
    set((s) => {
      const imoveis = s.imoveis.includes(cod)
        ? s.imoveis.filter((c) => c !== cod)
        : s.imoveis.length < MAX_IMOVEIS_ANALISE ? [...s.imoveis, cod] : s.imoveis
      salvar(imoveis)
      return { imoveis }
    }),
  corrigir: (relatorio, imoveis, analises) => {
    const lista = imoveis.slice(0, MAX_IMOVEIS_ANALISE)
    salvar(lista)
    salvarCorrecao({ relatorio, analises })
    set({ imoveis: lista, correcao: { relatorio, analises } })
  },
  cancelarCorrecao: () => {
    salvarCorrecao(null)
    set({ correcao: null })
  },
  limpar: () => {
    salvar([])
    salvarCorrecao(null)
    set({ imoveis: [], correcao: null })
  },
}))
