import { create } from 'zustand'

/** Largura do painel em px: a padrão e os limites do arrasto da borda. */
export const LARGURA_PADRAO = 404
export const LARGURA_MINIMA = 320
export const LARGURA_MAXIMA = 640
/** O trilho, à esquerda do painel, e o mínimo de mapa que fica à vista ao lado dele. */
const TRILHO = 56
const MAPA_MINIMO = 360
const CHAVE_LARGURA = 'nodaltrace:painel-largura'

/** A largura dentro dos limites, sem tirar do mapa mais que a tela permite. */
export const limitarLargura = (px: number, tela: number) =>
  Math.round(Math.max(LARGURA_MINIMA, Math.min(px, LARGURA_MAXIMA, tela - TRILHO - MAPA_MINIMO)))

/** A largura guardada neste navegador (só conveniência de quem vê: sem ela, vale a padrão). */
function larguraSalva(): number {
  try {
    const n = Number(localStorage.getItem(CHAVE_LARGURA))
    return n ? limitarLargura(n, globalThis.innerWidth ?? 1440) : LARGURA_PADRAO
  } catch {
    return LARGURA_PADRAO
  }
}

/** O painel lateral: se está aberto, a largura e quais seções o usuário abriu. */
interface EstadoPainel {
  aberto: boolean
  largura: number
  /** Seções abertas pelo usuário, pela chave de cada uma. Começam todas recolhidas. */
  secoesAbertas: Set<string>
  abrir: () => void
  alternar: () => void
  /** Muda a largura (limitada); com `salvar`, guarda no navegador (no fim do arrasto, não a cada movimento). */
  setLargura: (px: number, salvar?: boolean) => void
  alternarSecao: (chave: string) => void
  abrirSecao: (chave: string) => void
}

export const usePainel = create<EstadoPainel>((set, get) => ({
  aberto: true,
  largura: larguraSalva(),
  secoesAbertas: new Set(),
  abrir: () => set({ aberto: true }),
  alternar: () => set((s) => ({ aberto: !s.aberto })),
  setLargura: (px, salvar = false) => {
    const largura = limitarLargura(px, innerWidth)
    if (largura !== get().largura) set({ largura })
    if (salvar) try { localStorage.setItem(CHAVE_LARGURA, String(largura)) } catch { /* vale até recarregar */ }
  },
  alternarSecao: (chave) =>
    set((s) => {
      const secoesAbertas = new Set(s.secoesAbertas)
      if (!secoesAbertas.delete(chave)) secoesAbertas.add(chave)
      return { secoesAbertas }
    }),
  abrirSecao: (chave) => set((s) => ({ secoesAbertas: new Set(s.secoesAbertas).add(chave) })),
}))
