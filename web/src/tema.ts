import { create } from 'zustand'

/**
 * Tema da interface: o escuro (o padrão) ou o claro. No mapa, só o que fica fora do Brasil muda com ele (map/cores.ts).
 * Os tokens de cor ficam em styles/nodaltrace-ui.css e mudam com o atributo data-tema do <html>.
 */
export type Tema = 'escuro' | 'claro'

export const TEMA_PADRAO: Tema = 'escuro'
const CHAVE = 'nodaltrace.tema'

/** O tema guardado neste navegador; qualquer outro valor (os antigos "sistema" e "nodaltrace", por exemplo) é o padrão. */
export const lerTema = (salvo: string | null | undefined): Tema => (salvo === 'claro' || salvo === 'escuro' ? salvo : TEMA_PADRAO)

function temaSalvo(): Tema {
  try {
    return lerTema(localStorage.getItem(CHAVE))
  } catch {
    return TEMA_PADRAO // armazenamento indisponível
  }
}

/** O botão do trilho troca um pelo outro. */
export const PROXIMO: Record<Tema, Tema> = { escuro: 'claro', claro: 'escuro' }
export const ROTULO_TEMA: Record<Tema, string> = { escuro: 'Dark theme', claro: 'Light theme' }

/** A cor da barra do navegador no celular (meta theme-color): a do trilho de cada tema. */
const COR_BARRA: Record<Tema, string> = { escuro: '#0A0C0B', claro: '#FFFFFF' }

function aplicar(tema: Tema) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.tema = tema
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', COR_BARRA[tema])
}

interface EstadoTema {
  tema: Tema
  setTema: (t: Tema) => void
}

export const useTema = create<EstadoTema>((set) => ({
  tema: temaSalvo(),
  setTema: (tema) => {
    try { localStorage.setItem(CHAVE, tema) } catch { /* vale até recarregar */ }
    set({ tema })
  },
}))

// Aplica antes do primeiro quadro.
aplicar(useTema.getState().tema)
useTema.subscribe((s) => aplicar(s.tema))
