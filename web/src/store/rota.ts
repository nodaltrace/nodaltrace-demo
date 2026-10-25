import { create } from 'zustand'
import { INICIO, caminhoDe, lerRota, type Rota } from './caminhos'

export { caminhoDe, lerRota, montandoSelecao, naAnalise, type Rota } from './caminhos'

/** A rota atual (store/caminhos.ts), que a URL guarda, e a navegação entre as telas pelo histórico do navegador. */
interface EstadoRota {
  rota: Rota
  /** Quantos passos dentro do app há antes deste no histórico: com zero, o voltar sairia do app. */
  profundidade: number
}

const profundidadeDo = (estado: unknown) => (typeof (estado as { nt?: unknown })?.nt === 'number' ? (estado as { nt: number }).nt : 0)

export const useRota = create<EstadoRota>(() => ({
  rota: lerRota(location.pathname),
  profundidade: profundidadeDo(history.state),
}))

// Endereço de um imóvel ou relatório aberto sem enquadramento (#zoom/lat/lon): o mapa vai até ele quando a ficha chega.
let enquadrar = !location.hash && ['imovel', 'relatorio'].includes(useRota.getState().rota.tela)

/** Se a tela aberta pelo endereço deve enquadrar o mapa nela. Vale uma vez, e só antes de qualquer navegação. */
export function enquadrarAoAbrir(): boolean {
  const e = enquadrar
  enquadrar = false
  return e
}

// A barra de endereço fica com o caminho da rota: o desconhecido vira o início; o código em minúsculas, em maiúsculas.
if (caminhoDe(useRota.getState().rota) !== location.pathname)
  history.replaceState(history.state, '', `${caminhoDe(useRota.getState().rota)}${location.search}${location.hash}`)

/** Vai para a rota, empilhando no histórico (ou no lugar da atual, com `substituir`). A mesma rota não empilha. */
export function navegar(rota: Rota, { substituir = false } = {}) {
  enquadrar = false
  const caminho = caminhoDe(rota)
  if (caminho === location.pathname) return
  const profundidade = useRota.getState().profundidade + (substituir ? 0 : 1)
  const url = `${caminho}${location.search}${location.hash}`
  // `anterior`: o caminho do passo de baixo, para voltarPara saber se voltar no histórico leva aonde se quer.
  if (substituir) history.replaceState({ ...history.state, nt: profundidade }, '', url)
  else history.pushState({ nt: profundidade, anterior: location.pathname }, '', url)
  useRota.setState({ rota, profundidade })
}

/** O voltar do painel: o do navegador, enquanto houver passo dentro do app; no primeiro, o início. */
export function voltar() {
  if (useRota.getState().profundidade > 0) history.back()
  else navegar(INICIO, { substituir: true })
}

/** Volta a uma rota certa: pelo histórico, se ela é o passo de baixo; senão, no lugar da atual. */
export function voltarPara(rota: Rota) {
  const anterior = (history.state as { anterior?: unknown } | null)?.anterior
  if (useRota.getState().profundidade > 0 && anterior === caminhoDe(rota)) history.back()
  else navegar(rota, { substituir: true })
}

addEventListener('popstate', () => {
  enquadrar = false
  useRota.setState({ rota: lerRota(location.pathname), profundidade: profundidadeDo(history.state) })
})
