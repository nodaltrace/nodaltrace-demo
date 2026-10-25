/**
 * Até onde a câmera vai: na demo do hackathon, o mapa é só o Rio Grande do Sul. Puro, sem MapLibre (camera.ts o liga ao
 * `transformConstrain`). As contas são no Mercator do MapLibre, em fração do mundo (0 a 1), com tiles de 512 px.
 */
import rs from './rs.json'

/** A caixa do contorno do RS em rs.json (oeste, sul, leste, norte). */
export const REGIAO: [number, number, number, number] = [-57.65, -33.75, -49.69, -27.08]
/** Folga em volta da caixa do RS, em graus. */
const FOLGA_GRAUS = 1
/**
 * Aproximado, o centro da área visível fica no máximo a esta fração do menor lado dela fora do contorno do RS, e nunca
 * menos que FOLGA_CONTORNO graus: o contorno das UFs é simplificado e desvia até 0,02° da divisa real.
 */
const FOLGA_TELA = 0.35
const FOLGA_CONTORNO = 0.04
export const ZOOM_MAXIMO = 17

const TILE = 512
const xDe = (lng: number) => (lng + 180) / 360
const yDe = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2
const lngDe = (x: number) => x * 360 - 180
const latDe = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(Math.PI * (1 - 2 * y))) - 90

type P = [number, number]

/** Os anéis do contorno do RS (o continente e as ilhas), em Mercator. */
const ANEIS: P[][] = rs.features.find((f) => f.properties.parte === 'rs')!.geometry.coordinates.map(
  ([anel]) => anel.map(([lng, lat]) => [xDe(lng), yDe(lat)] as P),
)

/** Ponto dentro do RS (par ou ímpar de travessias, somando todos os anéis). */
function dentro([x, y]: P): boolean {
  let d = false
  for (const anel of ANEIS)
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      const [xi, yi] = anel[i]
      const [xj, yj] = anel[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) d = !d
    }
  return d
}

/** O ponto do contorno mais perto. */
function maisPerto([x, y]: P): P {
  let melhor: P = [x, y]
  let minimo = Infinity
  for (const anel of ANEIS)
    for (let i = 1; i < anel.length; i++) {
      const [ax, ay] = anel[i - 1]
      const [bx, by] = anel[i]
      const dx = bx - ax
      const dy = by - ay
      const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0
      const q: P = [ax + t * dx, ay + t * dy]
      const d = (q[0] - x) ** 2 + (q[1] - y) ** 2
      if (d < minimo) [minimo, melhor] = [d, q]
    }
  return melhor
}

/** A área visível do mapa em pixels: o mapa menos a margem da câmera (o painel e os controles). */
export interface Area {
  largura: number
  altura: number
}

/**
 * Prende a câmera no RS. O centro da câmera é o centro da área visível. O zoom não afasta além de o RS inteiro (com a
 * folga) caber nela. O centro só anda até a borda da caixa do RS chegar à borda da área visível e, com o mapa
 * aproximado, não sai de perto do contorno: dentro da caixa há Santa Catarina, Uruguai, Argentina e mar, cobertos pela
 * máscara, e a tela ficaria vazia.
 */
export function restringir(lng: number, lat: number, zoom: number, area: Area): { lng: number; lat: number; zoom: number } {
  const [x0, x1] = [xDe(REGIAO[0] - FOLGA_GRAUS), xDe(REGIAO[2] + FOLGA_GRAUS)]
  const [y0, y1] = [yDe(REGIAO[3] + FOLGA_GRAUS), yDe(REGIAO[1] - FOLGA_GRAUS)]
  const minimo = Math.log2(Math.min(area.largura / ((x1 - x0) * TILE), area.altura / ((y1 - y0) * TILE)))
  const z = Math.min(ZOOM_MAXIMO, Math.max(zoom, minimo))
  const mundo = TILE * 2 ** z

  let p: P = [xDe(lng), yDe(lat)]
  if (!dentro(p)) {
    const folga = Math.max((FOLGA_TELA * Math.min(area.largura, area.altura)) / mundo, FOLGA_CONTORNO / 360)
    const q = maisPerto(p)
    const d = Math.hypot(p[0] - q[0], p[1] - q[1])
    if (d > folga) p = [q[0] + ((p[0] - q[0]) * folga) / d, q[1] + ((p[1] - q[1]) * folga) / d]
  }
  // Com o RS menor que a área visível num eixo, ele fica no meio dela; senão, o centro anda até a borda encostar.
  const prender = (v: number, a: number, b: number, meia: number) => (b - a <= 2 * meia ? (a + b) / 2 : Math.min(b - meia, Math.max(a + meia, v)))
  return {
    lng: lngDe(prender(p[0], x0, x1, area.largura / 2 / mundo)),
    lat: latDe(prender(p[1], y0, y1, area.altura / 2 / mundo)),
    zoom: z,
  }
}
