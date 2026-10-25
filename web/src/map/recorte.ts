/**
 * Quais tiles tocam o Brasil, para não pedir ao Mapbox a foto (nem os polígonos de países) dos vizinhos e do mar: a
 * caixa do Brasil é ~2,5 vezes a área do país. O contorno é o das UFs do IBGE (public/geo/uf.json, o mesmo das linhas
 * de UF), com uma folga que cobre a simplificação dele; as ilhas oceânicas que ele não traz entram como pontos.
 */

export type Caixa = [number, number, number, number]
type Ponto = [number, number]

export interface Contorno {
  caixa: Caixa
  anel: Ponto[]
}

/**
 * Folga em graus (~9 km): cobre a simplificação do contorno e as ilhas perto da costa que ele não traz (conferido com
 * os 14.789 vértices do polígono do Brasil do Mapbox Countries v1, até o zoom 16). Um tile a mais na divisa custa pouco.
 */
export const FOLGA_GRAUS = 0.08

/**
 * Ilhas brasileiras fora do contorno das UFs (lon, lat): Trindade e Martim Vaz, Atol das Rocas, São Pedro e São Paulo,
 * Abrolhos, Alcatrazes, Queimada Grande e Pequena, Arvoredo, Vitória e Montão de Trigo.
 */
export const ILHAS: Ponto[] = [
  [-29.32, -20.51], [-28.85, -20.49], [-33.81, -3.86], [-29.35, 0.92], [-38.70, -17.96], [-45.69, -24.10], [-46.67, -24.49],
  [-48.37, -27.27], [-45.02, -23.74], [-45.78, -23.865], [-46.807, -24.375],
]

/**
 * Águas e terras que o IBGE deixa fora das UFs, como retângulos que as contêm (o miolo fica a mais de uma folga da
 * margem): as lagoas dos Patos e Mirim e os canais da foz do Amazonas. O excesso (faixa de mar e de Uruguai) custa
 * poucos tiles. Conferido contra a união dos biomas do IBGE no PostGIS, tile a tile, até o zoom 18.
 */
export const LAGOAS: Ponto[][] = [
  [[-52.25, -32.25], [-50.55, -32.25], [-50.55, -29.95], [-52.25, -29.95], [-52.25, -32.25]],
  [[-53.8, -33.7], [-52.4, -33.7], [-52.4, -31.7], [-53.8, -31.7], [-53.8, -33.7]],
  [[-50.01, 0.36], [-49.88, 0.36], [-49.88, 0.49], [-50.01, 0.49], [-50.01, 0.36]],
  [[-49.18, 0.045], [-49.16, 0.045], [-49.16, 0.065], [-49.18, 0.065], [-49.18, 0.045]],
]

const caixaDe = (anel: Ponto[]): Caixa => {
  let [o, s, l, n] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of anel) {
    if (x < o) o = x
    if (x > l) l = x
    if (y < s) s = y
    if (y > n) n = y
  }
  return [o, s, l, n]
}

/** Os anéis externos das UFs (os buracos não importam: dentro do Brasil tudo é Brasil), as lagoas e as ilhas como pontos. */
export function contornos(uf: { features: { geometry: { type: string; coordinates: unknown } }[] }): Contorno[] {
  const out: Contorno[] = []
  for (const f of uf.features) {
    const g = f.geometry
    const poligonos = (g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]) as Ponto[][][]
    for (const p of poligonos) if (p[0]?.length) out.push({ caixa: caixaDe(p[0]), anel: p[0] })
  }
  for (const a of LAGOAS) out.push({ caixa: caixaDe(a), anel: a })
  for (const i of ILHAS) out.push({ caixa: [i[0], i[1], i[0], i[1]], anel: [i] })
  return out
}

/** Limites em lon/lat do tile z/x/y (esquema XYZ, Web Mercator). */
export function limitesDoTile(z: number, x: number, y: number): Caixa {
  const n = 2 ** z
  const lat = (t: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)]
}

const dentroDoAnel = ([px, py]: Ponto, anel: Ponto[]) => {
  let dentro = false
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i]
    const [xj, yj] = anel[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) dentro = !dentro
  }
  return dentro
}

/** O segmento a–b passa pelo retângulo? (Liang–Barsky.) */
const segmentoCorta = ([ax, ay]: Ponto, [bx, by]: Ponto, [o, s, l, n]: Caixa) => {
  const dx = bx - ax
  const dy = by - ay
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [[-dx, ax - o], [dx, l - ax], [-dy, ay - s], [dy, n - ay]]) {
    if (p === 0) {
      if (q < 0) return false
    } else {
      const t = q / p
      if (p < 0) t0 = Math.max(t0, t)
      else t1 = Math.min(t1, t)
      if (t0 > t1) return false
    }
  }
  return true
}

/** O retângulo (já com a folga) encosta no contorno: tem vértice dentro, está dentro dele ou é cortado por uma aresta. */
function toca(r: Caixa, c: Contorno): boolean {
  const [o, s, l, n] = r
  if (c.caixa[2] < o || c.caixa[0] > l || c.caixa[3] < s || c.caixa[1] > n) return false
  const a = c.anel
  if (a.some(([x, y]) => x >= o && x <= l && y >= s && y <= n)) return true
  if (a.length < 3) return false
  if (dentroDoAnel([(o + l) / 2, (s + n) / 2], a)) return true
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) if (segmentoCorta(a[j], a[i], r)) return true
  return false
}

/** O tile z/x/y toca o Brasil (com a folga)? */
export function tileTocaBrasil(brasil: Contorno[], z: number, x: number, y: number, folga = FOLGA_GRAUS): boolean {
  const [o, s, l, n] = limitesDoTile(z, x, y)
  const r: Caixa = [o - folga, s - folga, l + folga, n + folga]
  return brasil.some((c) => toca(r, c))
}
