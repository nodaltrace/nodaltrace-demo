import { afterEach, describe, expect, it, vi } from 'vitest'

/** O módulo lê o token ao ser importado: cada caso importa de novo, com o token e o armazenamento do caso. */
async function carregar(token: string, salvo: string | null) {
  vi.stubEnv('VITE_MAPBOX_TOKEN', token)
  const guardado = new Map(salvo ? [['nodaltrace:mapa-base', salvo]] : [])
  vi.stubGlobal('localStorage', { getItem: (k: string) => guardado.get(k) ?? null, setItem: (k: string, v: string) => guardado.set(k, v) })
  vi.resetModules()
  return { ...(await import('./satelite')), guardado }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('mapa-base guardado', () => {
  it('começa no satélite quando há token e nada guardado', async () => {
    expect((await carregar('pk.teste', null)).mapaBaseSalvo()).toBe('satelite')
  })

  it('lembra a escolha do neutro entre recarregamentos', async () => {
    const { mapaBaseSalvo, salvarMapaBase, guardado } = await carregar('pk.teste', null)
    salvarMapaBase('neutro')
    expect(guardado.get('nodaltrace:mapa-base')).toBe('neutro')
    expect(mapaBaseSalvo()).toBe('neutro')
  })

  it('sem token fica no neutro, mesmo com o satélite guardado', async () => {
    expect((await carregar('', 'satelite')).mapaBaseSalvo()).toBe('neutro')
  })

  it('sem armazenamento, vale o padrão', async () => {
    const { mapaBaseSalvo } = await carregar('pk.teste', null)
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('bloqueado') } })
    expect(mapaBaseSalvo()).toBe('satelite')
  })
})

describe('tiles do Mapbox pelo protocolo nt-mapbox', () => {
  const brasil = async () => (await import('./recorte')).contornos({
    features: [{ geometry: { type: 'Polygon', coordinates: [[[-50, -20], [-40, -20], [-40, -10], [-50, -10], [-50, -20]]] } }],
  })

  it('não pede ao Mapbox o tile que não toca o Brasil: foto transparente, países vazio', async () => {
    const { carregarTileMapbox } = await carregar('pk.teste', null)
    const buscar = vi.fn()
    const foto = await carregarTileMapbox('nt-mapbox://satelite/10/100/500', new AbortController(), buscar, brasil)
    const paises = await carregarTileMapbox('nt-mapbox://paises/10/100/500', new AbortController(), buscar, brasil)
    expect(buscar).not.toHaveBeenCalled()
    expect(new Uint8Array(foto.data as ArrayBuffer).slice(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]))
    expect((paises.data as ArrayBuffer).byteLength).toBe(0)
  })

  it('pede ao Mapbox o tile que toca o Brasil, com o token e o cancelamento do MapLibre', async () => {
    const { carregarTileMapbox } = await carregar('pk.teste', null)
    const buscar = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Cache-Control': 'max-age=60' } }))
    const abort = new AbortController()
    // Tile do zoom 4 que contém o quadrado (-50..-40, -20..-10).
    const r = await carregarTileMapbox('nt-mapbox://satelite/4/5/8', abort, buscar as never, brasil)
    expect(buscar).toHaveBeenCalledWith('https://api.mapbox.com/v4/mapbox.satellite/4/5/8@2x.jpg80?access_token=pk.teste', { signal: abort.signal })
    expect(new Uint8Array(r.data as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]))
    expect(r.cacheControl).toBe('max-age=60')
    await carregarTileMapbox('nt-mapbox://paises/4/5/8', abort, buscar as never, brasil)
    expect(buscar).toHaveBeenLastCalledWith('https://api.mapbox.com/v4/mapbox.country-boundaries-v1/4/5/8.vector.pbf?access_token=pk.teste', { signal: abort.signal })
  })

  it('os países vão um tile além da foto, para a máscara cobrir a borda do tile da foto', async () => {
    const { carregarTileMapbox } = await carregar('pk.teste', null)
    const buscar = vi.fn(async () => new Response(new Uint8Array([9])))
    // Zoom 10, logo a oeste do quadrado (-50…-40): o tile vai de -50,63 a -50,27, fora da folga da foto (0,08°).
    const y = Math.floor(((1 - Math.log(Math.tan((-15 * Math.PI) / 180) + 1 / Math.cos((-15 * Math.PI) / 180)) / Math.PI) / 2) * 1024)
    const foto = await carregarTileMapbox(`nt-mapbox://satelite/10/368/${y}`, new AbortController(), buscar as never, brasil)
    expect(buscar).not.toHaveBeenCalled()
    expect((foto.data as ArrayBuffer).byteLength).toBeGreaterThan(0)
    await carregarTileMapbox(`nt-mapbox://paises/10/368/${y}`, new AbortController(), buscar as never, brasil)
    expect(buscar).toHaveBeenCalledOnce()
  })

  it('erro do Mapbox vira erro do tile (o MapLibre trata como tile que falhou)', async () => {
    const { carregarTileMapbox } = await carregar('pk.teste', null)
    const buscar = vi.fn(async () => new Response('', { status: 401 }))
    // A foto vazia é uma cópia por tile.
    const a = await carregarTileMapbox('nt-mapbox://satelite/10/100/500', new AbortController(), buscar as never, brasil)
    const b = await carregarTileMapbox('nt-mapbox://satelite/10/100/500', new AbortController(), buscar as never, brasil)
    expect(a.data).not.toBe(b.data)
    await expect(carregarTileMapbox('nt-mapbox://satelite/4/5/8', new AbortController(), buscar as never, brasil)).rejects.toThrow('401')
    const vazio = vi.fn(async () => new Response('', { status: 404 }))
    // 404 do Mapbox é tile sem nada (países no mar): vazio, não erro.
    expect(((await carregarTileMapbox('nt-mapbox://paises/4/5/8', new AbortController(), vazio as never, brasil)).data as ArrayBuffer).byteLength).toBe(0)
    await expect(carregarTileMapbox('https://outro/1/2/3', new AbortController(), buscar as never, brasil)).rejects.toThrow('desconhecida')
  })
})
