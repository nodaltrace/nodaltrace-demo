import { LngLat, type Map as MapLibre } from 'maplibre-gl'
import type { Coord } from '../api/tipos'
import { LARGURA_PADRAO, usePainel } from '../store/painel'
import { restringir } from './limites'

/** Tela estreita (celular): o painel aberto cobre o mapa inteiro. */
const ESTREITA = 760
const estreita = () => (globalThis.innerWidth ?? 1440) <= ESTREITA

/**
 * Margem esquerda do mapa visível: o trilho e o painel aberto (na largura dele, com uma folga), ou só o trilho. Em tela
 * estreita o painel cobre o mapa: só o trilho conta.
 */
export const margemEsquerda = (painelAberto: boolean, tela: number, larguraPainel = LARGURA_PADRAO) =>
  tela <= ESTREITA ? 72 : painelAberto ? 56 + larguraPainel + 40 : 110

let mapa: MapLibre | null = null
// O painel abre aberto: a margem já parte dele, para o primeiro enquadramento caber na área visível.
let margem = margemEsquerda(true, globalThis.innerWidth ?? 1440, usePainel.getState().largura)
/** Enquadramento pedido antes de o mapa carregar (um endereço aberto direto): vale quando ele registrar. */
let pendente: [number, number, number, number] | null = null

export { ZOOM_MAXIMO } from './limites'

/** Onde o mapa abre sem enquadramento na URL. Demo do hackathon: o Rio Grande do Sul inteiro, onde estão os dados. */
export const VISTA_INICIAL = { longitude: -53.3, latitude: -30.1, zoom: 6 }

/**
 * Na demo do hackathon o mapa é só o RS (`restringir`, em limites.ts). Vai em `transformConstrain`, do MapLibre: vale
 * para arrastar, zoom e animações. A área visível é o mapa menos a margem da câmera, onde ficam o painel e os controles.
 */
export function prenderNoRS(centro: LngLat, zoom: number): { center: LngLat; zoom: number } {
  const { left = 0, right = 0, top = 0, bottom = 0 } = mapa?.getPadding() ?? camera.padding()
  const largura = Math.max(1, (mapa?.getContainer().clientWidth ?? innerWidth) - left - right)
  const altura = Math.max(1, (mapa?.getContainer().clientHeight ?? innerHeight) - top - bottom)
  const r = restringir(centro.lng, centro.lat, zoom, { largura, altura })
  return { center: new LngLat(r.lng, r.lat), zoom: r.zoom }
}

export const camera = {
  registrar(m: MapLibre | null) {
    mapa = m
    if (m && pendente) {
      this.limites(pendente)
      pendente = null
    }
  },
  /**
   * O painel abriu, fechou ou mudou de largura: a área visível muda e o mapa acompanha, no tempo da animação do painel
   * (`duracao`), ou na hora, enquanto a borda é arrastada.
   */
  definirMargem(px: number, duracao = 300) {
    if (px === margem) return
    margem = px
    if (duracao) mapa?.easeTo({ padding: this.padding(), duration: duracao })
    else mapa?.jumpTo({ padding: this.padding() })
  },
  /** O mapa principal, para quem precisa acompanhar a câmera dele (a comparação de imagens). */
  principal() {
    return mapa
  },
  voarPara(coord: Coord, zoom: number) {
    mapa?.flyTo({ center: coord, zoom, padding: this.padding(), duration: 1600, essential: true })
  },
  /** A margem da câmera: o painel à esquerda; em volta, uma folga (no celular, menor, e embaixo a escala). */
  padding() {
    return estreita() ? { left: margem, top: 24, right: 24, bottom: 110 } : { left: margem, top: 90, right: 90, bottom: 90 }
  },
  /**
   * Enquadra um retângulo [oeste, sul, leste, norte] pequeno, como um imóvel do CAR, no meio da área visível. A margem
   * do painel já está no mapa (`padding`), e o MapLibre a soma à que o enquadramento recebe: passá-la de novo empurrava o
   * imóvel para a direita e, com o painel largo ou a janela estreita, não sobrava área e o mapa nem se mexia. O voo leva
   * a margem certa, caso o painel ainda esteja animando.
   */
  limites(caixa: [number, number, number, number]) {
    if (!mapa) {
      pendente = caixa
      return
    }
    const [o, s, l, n] = caixa
    const alvo = mapa.cameraForBounds([[o, s], [l, n]], { maxZoom: 15 })
    if (alvo) mapa.flyTo({ ...alvo, padding: this.padding(), duration: 1800, essential: true })
  },
  /** Os botões de mostrar no mapa: enquadram e, no celular, onde o painel cobre o mapa, fecham o painel. */
  mostrar(caixa: [number, number, number, number]) {
    if (estreita()) usePainel.setState({ aberto: false })
    this.limites(caixa)
  },
}
