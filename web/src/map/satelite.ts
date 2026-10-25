import { FOLGA_GRAUS, contornos, tileTocaBrasil, type Contorno } from './recorte'

/** Token público do Mapbox (pk.…) em web/.env.local. Sem ele, o mapa fica só no estilo neutro. */
const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined

export const SATELITE_DISPONIVEL = !!TOKEN

/** Prefixo das URLs dos tiles do Mapbox no estilo: passam por `carregarTileMapbox`, que não pede o que fica fora do Brasil. */
export const PROTOCOLO = 'nt-mapbox'

/**
 * Imagens de satélite do Mapbox em raster. Tiles de 512 px (@2x): cada um cobre a área de quatro de 256 px, então são
 * menos requisições (o Mapbox cobra por tile). JPEG 80: bem mais leve que o 90, sem diferença visível na foto.
 */
export const TILES_SATELITE = [`${PROTOCOLO}://satelite/{z}/{x}/{y}`]

/** Polígonos dos países (Mapbox Countries v1), que recortam a foto no Brasil. Tiles vetoriais: Vector Tiles API. */
export const TILES_PAISES = [`${PROTOCOLO}://paises/{z}/{x}/{y}`]

const URL_MAPBOX = {
  satelite: (z: string, x: string, y: string) => `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.jpg80?access_token=${TOKEN}`,
  paises: (z: string, x: string, y: string) => `https://api.mapbox.com/v4/mapbox.country-boundaries-v1/${z}/${x}/${y}.vector.pbf?access_token=${TOKEN}`,
}

/** PNG transparente de 1×1: o tile da foto que não toca o Brasil, sem pedido ao Mapbox. */
const PNG_VAZIO = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGBgAAAABQABeqhXUAAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)).buffer

let brasil: Promise<Contorno[]> | null = null
/** O contorno do Brasil, lido uma vez do mesmo arquivo das linhas de UF. */
const contornoDoBrasil = () => (brasil ??= fetch('/geo/uf.json').then((r) => r.json()).then(contornos).catch((e) => {
  brasil = null
  throw e
}))

/** O que o `addProtocol` do MapLibre espera de volta (GetResourceResponse). */
export interface TileCarregado {
  data: ArrayBuffer
  cacheControl?: string | null
  expires?: string | null
}

/**
 * Carrega um tile `nt-mapbox://{satelite|paises}/z/x/y` (registrado com `addProtocol` do MapLibre, em MapView). Tile
 * que não toca o Brasil nem sai: a foto volta transparente (o mapa neutro aparece) e o de países, vazio (lá vale a
 * máscara local, `mascara-longe` em estilo.ts). Os outros vão ao Mapbox como iriam sem o protocolo.
 *
 * Os países vão um tile além da foto: onde a foto acaba, a máscara do tile vizinho cobre a coluna de pixels da borda do
 * tile da foto, que a máscara do próprio tile deixava à mostra.
 */
export async function carregarTileMapbox(url: string, abort: AbortController, buscar: typeof fetch = fetch, contorno = contornoDoBrasil): Promise<TileCarregado> {
  const m = new RegExp(`^${PROTOCOLO}://(satelite|paises)/(\\d+)/(\\d+)/(\\d+)$`).exec(url)
  if (!m) throw new Error(`URL de tile desconhecida: ${url}`)
  const [, tipo, z, x, y] = m as unknown as [string, 'satelite' | 'paises', string, string, string]
  const folga = tipo === 'paises' ? FOLGA_GRAUS + 360 / 2 ** +z : FOLGA_GRAUS
  // Cópia por tile: o MapLibre pode transferir o buffer a um worker, e um compartilhado ficaria inutilizado.
  const vazio = (): TileCarregado => ({ data: tipo === 'satelite' ? PNG_VAZIO.slice(0) : new ArrayBuffer(0) })
  if (!tileTocaBrasil(await contorno(), +z, +x, +y, folga)) return vazio()
  const r = await buscar(URL_MAPBOX[tipo](z, x, y), { signal: abort.signal })
  // Tile sem nada (ex.: países no mar perto da costa): o Mapbox responde 404, que o MapLibre trataria como tile vazio.
  if (r.status === 404) return vazio()
  if (!r.ok) throw new Error(`Mapbox respondeu ${r.status} ao tile ${tipo} ${z}/${x}/${y}`)
  return { data: await r.arrayBuffer(), cacheControl: r.headers.get('Cache-Control'), expires: r.headers.get('Expires') }
}

/** Os créditos que os termos do Mapbox pedem para os tiles dele; o logo vai à parte (LogoMapbox, em MapView). */
export const ATRIBUICAO_SATELITE = [
  '<a href="https://www.mapbox.com/about/maps/" target="_blank">© Mapbox</a>',
  '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap</a>',
  '<a href="https://www.maxar.com/" target="_blank">© Maxar</a>',
  '<a href="https://apps.mapbox.com/feedback/" target="_blank"><strong>Improve this map</strong></a>',
].join(' ')

export type MapaBase = 'satelite' | 'neutro'

const CHAVE = 'nodaltrace:mapa-base'

/** A escolha deste navegador; sem ela, o satélite sempre que houver token. */
export function mapaBaseSalvo(): MapaBase {
  let salvo: string | null = null
  try { salvo = localStorage.getItem(CHAVE) } catch { /* armazenamento indisponível */ }
  if (salvo === 'neutro' || !SATELITE_DISPONIVEL) return 'neutro'
  return 'satelite'
}

export function salvarMapaBase(base: MapaBase) {
  try { localStorage.setItem(CHAVE, base) } catch { /* vale até recarregar */ }
}
