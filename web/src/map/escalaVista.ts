/**
 * Escala e altitude aproximadas da vista, a partir do zoom e da latitude do centro (Mercator).
 */

import type { Camadas } from '../store/mapa'

const CIRCUNFERENCIA_M = 40075016.686
/** Tamanho de um pixel de tela a 96 dpi, para a escala numérica (1:N). */
const PIXEL_M = 0.0254 / 96

export function metrosPorPixel(zoom: number, lat: number): number {
  return (CIRCUNFERENCIA_M * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom)
}

/** Altitude da câmera: com o campo de visão padrão do MapLibre (36,87°), ela fica a 1,5 × a altura do mapa do centro. */
export function altitudeM(zoom: number, lat: number, alturaPx: number): number {
  return metrosPorPixel(zoom, lat) * alturaPx * 1.5
}

/** Denominador da escala numérica (1:N), arredondado para dois algarismos significativos. */
export function denominador(zoom: number, lat: number): number {
  const n = metrosPorPixel(zoom, lat) / PIXEL_M
  const p = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1)
  return Math.round(n / p) * p
}

/** Barra de escala: a maior distância "redonda" (1, 2 ou 5 × 10ⁿ) que cabe em `maxPx`. */
export function barra(zoom: number, lat: number, maxPx = 110): { px: number; metros: number } {
  const mpp = metrosPorPixel(zoom, lat)
  const max = mpp * maxPx
  const base = 10 ** Math.floor(Math.log10(max))
  const metros = [5, 2, 1].map((k) => k * base).find((d) => d <= max) ?? base
  return { px: metros / mpp, metros }
}

/** A partir desta barra de escala (mapa muito afastado), nenhuma base de referência aparece. */
export const ESCALA_SEM_CAMADAS_M = 500_000

/** Mapa afastado demais: a barra de escala chega a 500 km ou mais e as bases de referência somem. */
export const semCamadas = (zoom: number, lat: number) => barra(zoom, lat).metros >= ESCALA_SEM_CAMADAS_M

/**
 * Camadas que saem por inteiro com o mapa afastado demais. O painel e o mapa leem daqui: quem entra ou sai do conjunto
 * muda os dois juntos.
 */
export const AFASTADO: { ocultas: ReadonlySet<keyof Camadas> } = {
  ocultas: new Set(['car', 'alertas', 'biomas']),
}

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

export const fmtDistancia = (m: number) => (m >= 1000 ? `${nf.format(m / 1000)} km` : `${nf.format(m)} m`)
export const fmtAltitude = (m: number) => (m >= 10000 ? `${nf.format(m / 1000)} km` : m >= 1000 ? `${nf1.format(m / 1000)} km` : `${nf.format(m)} m`)
export const fmtZoom = (z: number) => nf1.format(z)
export const fmtDenominador = (n: number) => `1:${nf.format(n)}`
