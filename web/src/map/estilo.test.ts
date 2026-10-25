import { featureFilter } from '@maplibre/maplibre-gl-style-spec'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAPA } from './cores'
import { estilo, estiloComRotulos } from './estilo'

describe('rótulos nativos do mapa', () => {
  it('desliga todos os textos e permite ligá-los novamente sem alterar a base', () => {
    const desligado = estiloComRotulos(false)
    const ligado = estiloComRotulos(true)
    const textos = estilo.layers.filter((l) => l.type === 'symbol' && l.layout?.['text-field'])
    expect(textos.length).toBeGreaterThan(0)
    for (const texto of textos) {
      expect(desligado.layers.find((l) => l.id === texto.id)?.layout?.visibility).toBe('none')
      expect(ligado.layers.find((l) => l.id === texto.id)?.layout?.visibility).toBe('visible')
      expect(texto.layout?.visibility).not.toBe('none')
    }
    expect(desligado.sources).toBe(estilo.sources)
    expect(desligado.layers.filter((l) => l.type !== 'symbol')).toEqual(estilo.layers.filter((l) => l.type !== 'symbol'))
  })
})

describe('mapa-base', () => {
  it('sobre o satélite, nomes e linhas ficam claros; no neutro, as cores do mapa, as mesmas em qualquer tema', () => {
    const pintura = (e: ReturnType<typeof estiloComRotulos>, id: string) => (e.layers.find((l) => l.id === id) as { paint: Record<string, unknown> }).paint
    expect(pintura(estiloComRotulos(true, 'satelite'), 'cidades')['text-color']).toBe('#FFFFFF')
    expect(pintura(estiloComRotulos(true, 'neutro'), 'cidades')['text-color']).toBe(MAPA.textoMapa)
    expect(pintura(estiloComRotulos(true, 'satelite'), 'mascara')['fill-color']).toBe(MAPA.fora)
    expect(pintura(estiloComRotulos(true, 'neutro'), 'terra')['background-color']).toBe(MAPA.brasil)
  })

  it('só o Brasil: as máscaras cobrem tudo o que vem dos tiles, e só os nomes dentro do Brasil aparecem', () => {
    const ordem = estilo.layers.map((l) => l.id)
    for (const id of ['agua', 'rios', 'vias', 'fronteira']) for (const m of ['mascara', 'mascara-perto', 'mascara-oceano']) expect(ordem.indexOf(id)).toBeLessThan(ordem.indexOf(m))
    const camada = (id: string) => estilo.layers.find((l) => l.id === id) as { filter: unknown; minzoom?: number; maxzoom?: number; layout?: { visibility?: string } }
    // Com o Brasil inteiro na tela, o contorno das UFs; aproximado, a faixa de ~3 km e o mar dos tiles, mais precisos.
    expect(camada('mascara')).toMatchObject({ filter: ['==', ['get', 'parte'], 'fora'], maxzoom: 5.5 })
    expect(camada('contorno-brasil').maxzoom).toBe(5.5)
    // Sem token do Mapbox (o caso deste teste): a faixa de ~3 km e a borda dos tiles.
    expect(camada('mascara-perto')).toMatchObject({ filter: ['==', ['get', 'parte'], 'perto'], minzoom: 5.5 })
    expect(camada('mascara-oceano')).toMatchObject({ filter: ['==', ['get', 'class'], 'ocean'], minzoom: 5.5 })
    expect(camada('fronteira').minzoom).toBe(5.5)
    // As UFs embaixo das máscaras: a linha simplificada da costa some no mar.
    expect(ordem.indexOf('uf')).toBeLessThan(ordem.indexOf('mascara-oceano'))
    const [, , dentro] = camada('cidades').filter as [string, unknown, [string, { type: string; coordinates: unknown[] }]]
    expect(dentro[0]).toBe('within')
    expect(dentro[1].type).toBe('MultiPolygon')
    // Demo do hackathon: a máscara de fora do RS em qualquer zoom, acima das outras e abaixo dos nomes, que só
    // aparecem dentro do RS com a faixa.
    expect(camada('mascara-rs')).toMatchObject({ filter: ['==', ['get', 'parte'], 'fora'] })
    expect(camada('mascara-rs').minzoom ?? camada('mascara-rs').maxzoom).toBeUndefined()
    for (const m of ['mascara', 'mascara-perto', 'mascara-oceano', 'contorno-brasil', 'uf']) expect(ordem.indexOf(m)).toBeLessThan(ordem.indexOf('mascara-rs'))
    expect(ordem.indexOf('mascara-rs')).toBe(ordem.indexOf('cidades') - 1)
    // Sem globo: nem céu nem atmosfera, e nada dos países do world-atlas.
    expect(estilo.sky).toBeUndefined()
    expect(estilo.sources.paises).toBeUndefined()
  })
})

describe('imagem de satélite', () => {
  // A camada depende do token, lido ao importar: cada caso importa o estilo de novo, com ou sem ele.
  const carregar = async (token: string) => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', token)
    vi.resetModules()
    return import('./estilo')
  }
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })
  const visibilidade = (e: { layers: { id: string; layout?: unknown }[] }, id: string) =>
    (e.layers.find((l) => l.id === id)?.layout as { visibility?: string } | undefined)?.visibility

  const faixa = (e: { layers: { id: string; minzoom?: number; maxzoom?: number }[] }, id: string) => {
    const l = e.layers.find((l) => l.id === id)
    return [l?.minzoom, l?.maxzoom]
  }

  it('com token, aparece só no satélite, por cima da água e dos rios', async () => {
    const { estiloComRotulos } = await carregar('pk.teste')
    const satelite = estiloComRotulos(true, 'satelite')
    const neutro = estiloComRotulos(true, 'neutro')
    expect(satelite.sources.satelite).toBeDefined()
    expect(visibilidade(satelite, 'satelite')).toBe('visible')
    expect(visibilidade(neutro, 'satelite')).toBe('none')
    // Água e rios ficam nos dois, por baixo da foto (ver o caso abaixo).
    for (const e of [satelite, neutro]) for (const id of ['agua', 'rios']) expect(visibilidade(e, id)).toBeUndefined()
    // Entre o fundo neutro e as linhas: as UFs, a borda e os nomes ficam por cima da foto.
    const ordem = satelite.layers.map((l) => l.id)
    expect(ordem.indexOf('satelite')).toBeGreaterThan(ordem.indexOf('brasil'))
    expect(ordem.indexOf('satelite')).toBeGreaterThan(ordem.indexOf('rios'))
    expect(ordem.indexOf('satelite')).toBeLessThan(ordem.indexOf('uf'))
  })

  it('só pede tiles dentro da caixa do RS (demo do hackathon), do zoom de detalhe em diante', async () => {
    const { estiloComRotulos } = await carregar('pk.teste')
    const e = estiloComRotulos(true, 'satelite')
    const fonte = e.sources.satelite as { bounds?: number[]; minzoom?: number }
    // Oeste, sul, leste, norte: o RS com a faixa da máscara fica dentro.
    expect(fonte.bounds).toEqual([-58.2, -34.3, -49.1, -26.5])
    expect(fonte.minzoom).toBeUndefined()
    // Com o Brasil inteiro na tela, o mapa-base é só o GeoJSON local: nenhum tile do Mapbox nem do OpenFreeMap.
    for (const id of ['satelite', 'mascara-longe', 'mascara-paises', 'mascara-oceano', 'fronteira-mapbox']) expect(faixa(e, id)).toEqual([5.5, undefined])
  })

  it('com token, o Brasil é recortado pelos países do Mapbox e pelo oceano, por cima da foto e das vias, nos dois mapas-base', async () => {
    const { estiloComRotulos } = await carregar('pk.teste')
    const paises = estiloComRotulos(true, 'satelite').sources.paises_mapbox as { type: string; tiles: string[]; maxzoom: number }
    expect(paises.type).toBe('vector')
    expect(paises.tiles[0]).toBe('nt-mapbox://paises/{z}/{x}/{y}')
    expect(paises.maxzoom).toBe(12)
    for (const base of ['satelite', 'neutro'] as const) {
      const e = estiloComRotulos(true, base)
      const ordem = e.layers.map((l) => l.id)
      for (const id of ['mascara-longe', 'mascara-paises', 'mascara-oceano']) {
        expect(ordem.indexOf(id)).toBeGreaterThan(ordem.indexOf('satelite'))
        expect(ordem.indexOf(id)).toBeGreaterThan(ordem.indexOf('vias'))
        expect(ordem.indexOf(id)).toBeGreaterThan(ordem.indexOf('uf'))
        expect(visibilidade(e, id)).toBeUndefined()
      }
      // A faixa estreita e a borda dos tiles são só para quando não há os polígonos do Mapbox.
      for (const id of ['mascara-perto', 'fronteira']) expect(ordem).not.toContain(id)
      expect(visibilidade(e, 'fronteira-mapbox')).toBeUndefined()
    }
    const e = estiloComRotulos(true, 'satelite')
    const mascara = e.layers.find((l) => l.id === 'mascara-paises') as { filter: unknown }
    // Avaliado pelo próprio avaliador de filtros do MapLibre, nas feições do Countries v1.
    const cobre = featureFilter(mascara.filter as never)
    const pais = (iso: string, worldview = 'all', disputed = 'false') =>
      cobre.filter({ zoom: 8 } as never, { type: 3, properties: { iso_3166_1: iso, worldview, disputed } } as never)
    expect(pais('BR')).toBe(false)
    expect(pais('D0BRUY1', 'all', 'true')).toBe(false) // Rincão de Artigas: fica na foto
    expect(pais('PY')).toBe(true)
    expect(pais('AR', 'US')).toBe(true)
    expect(pais('AR', 'CN')).toBe(false) // outra visão de mundo: não duplica a máscara
    expect(pais('D0GYSR1', 'US', 'true')).toBe(true) // Tigri, disputa sem o Brasil: coberta
    // Longe do Brasil, onde não há tile do Mapbox, a máscara local com a faixa de ~11 km.
    expect((e.layers.find((l) => l.id === 'mascara-longe') as { filter: unknown }).filter).toEqual(['==', ['get', 'parte'], 'longe'])
    // A borda é a do polígono do Brasil no Mapbox, a mesma geometria do recorte.
    const borda = featureFilter((e.layers.find((l) => l.id === 'fronteira-mapbox') as { filter: unknown }).filter as never)
    expect(borda.filter({ zoom: 8 } as never, { type: 3, properties: { iso_3166_1: 'BR', worldview: 'all' } } as never)).toBe(true)
    expect(borda.filter({ zoom: 8 } as never, { type: 3, properties: { iso_3166_1: 'PY', worldview: 'all' } } as never)).toBe(false)
  })

  it('água e rios sem teto nos dois mapas-base: no satélite ficam por baixo da foto', async () => {
    const { estiloComRotulos } = await carregar('pk.teste')
    for (const base of ['satelite', 'neutro'] as const) {
      const e = estiloComRotulos(true, base)
      expect(faixa(e, 'agua')).toEqual([5.5, undefined])
      expect(faixa(e, 'rios')).toEqual([6, undefined])
    }
  })

  it('a troca no lugar só mostra ou esconde a foto', async () => {
    const { aplicarMapaBase } = await carregar('pk.teste')
    const visiveis: Record<string, string> = {}
    const mapa = {
      getLayer: () => ({}),
      setLayoutProperty: (id: string, _: string, v: string) => { visiveis[id] = v },
      setPaintProperty: vi.fn(),
      setLayerZoomRange: vi.fn(),
    }
    aplicarMapaBase(mapa as never, 'satelite')
    expect(visiveis).toEqual({ satelite: 'visible' })
    aplicarMapaBase(mapa as never, 'neutro')
    expect(visiveis).toEqual({ satelite: 'none' })
    expect(mapa.setLayerZoomRange).not.toHaveBeenCalled()
  })

  it('sem token, nem a fonte nem a camada existem', async () => {
    const { estiloComRotulos } = await carregar('')
    const e = estiloComRotulos(true, 'satelite')
    expect(e.sources.satelite).toBeUndefined()
    expect(e.layers.some((l) => l.id === 'satelite')).toBe(false)
    expect(e.sources.paises_mapbox).toBeUndefined()
    // Sem os polígonos do Mapbox, a faixa de ~3 km e a borda dos tiles.
    for (const id of ['mascara-perto', 'fronteira']) expect(e.layers.map((l) => l.id)).toContain(id)
    // Sem foto, a água fica do zoom de detalhe em diante mesmo com o satélite escolhido.
    expect(faixa(e, 'agua')).toEqual([5.5, undefined])
  })
})
