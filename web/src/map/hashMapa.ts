/**
 * O enquadramento do mapa no fim da URL (#zoom/lat/lon, como o MapLibre escreve): dá para compartilhar ou reabrir uma
 * vista. O app escreve e lê o hash por conta própria, sem o `hash` do MapLibre: voltar e avançar no histórico muda a
 * tela do painel (store/rota.ts) e deixa a câmera onde o usuário a deixou.
 */

export interface VistaHash {
  zoom: number
  latitude: number
  longitude: number
}

/** O enquadramento de um hash (#zoom/lat/lon); null se não houver um válido. */
export function lerHash(hash: string): VistaHash | null {
  const [zoom, latitude, longitude] = hash.replace(/^#/, '').split('/').map(Number)
  if (![zoom, latitude, longitude].every(Number.isFinite) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { zoom, latitude, longitude }
}

/** O hash de um enquadramento, com as casas decimais que o zoom pede (a mesma conta do MapLibre). */
export function hashDe({ zoom, latitude, longitude }: VistaHash): string {
  const z = Math.round(zoom * 100) / 100
  const m = 10 ** Math.max(0, Math.ceil((z * Math.LN2 + Math.log(512 / 360 / 0.5)) / Math.LN10))
  return `#${z}/${Math.round(latitude * m) / m}/${Math.round(longitude * m) / m}`
}

/** Grava o enquadramento na URL, sem criar passo no histórico. */
export function gravarHash(v: VistaHash) {
  history.replaceState(history.state, '', `${location.pathname}${location.search}${hashDe(v)}`)
}
