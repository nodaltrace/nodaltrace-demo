import type { ExpressionSpecification, GeoJSONSourceSpecification, LayerSpecification, Map as MapLibre, StyleSpecification } from 'maplibre-gl'
import brasil from './brasil.json'
import rs from './rs.json'
import { MAPA, type CoresMapa } from './cores'
import { ATRIBUICAO_SATELITE, SATELITE_DISPONIVEL, TILES_PAISES, TILES_SATELITE, type MapaBase } from './satelite'

const NOME = ['coalesce', ['get', 'name:en'], ['get', 'name:pt'], ['get', 'name:latin'], ['get', 'name']] as const

/**
 * Demo do hackathon: o RS com a faixa de ~3 km, o buraco da máscara `mascara-rs` (rs.json sai de
 * deploy/demo/contorno-rs.sh). Só os nomes de lugares dentro dele aparecem; a faixa cobre o desvio da borda
 * simplificada, para as cidades da divisa e da costa não ficarem sem nome.
 */
const DENTRO: { type: 'MultiPolygon'; coordinates: number[][][][] } = {
  type: 'MultiPolygon',
  coordinates: rs.features.find((f) => f.properties.parte === 'faixa')!.geometry.coordinates,
}

/** Sobre a imagem de satélite, linhas e nomes ficam claros com halo escuro, para ler sobre a foto. */
const SOBRE_SATELITE = {
  vias: 'rgba(255,255,255,0.3)',
  uf: 'rgba(255,255,255,0.5)',
  fronteira: 'rgba(255,255,255,0.7)',
  texto: '#FFFFFF',
  halo: 'rgba(0,0,0,0.7)',
}

/**
 * Abaixo deste zoom o mapa-base é só o GeoJSON local (o Brasil, as máscaras e as UFs): os tiles do OpenFreeMap de zoom
 * baixo pesam centenas de KB cada e os do Mapbox são cobrados, sem acrescentar nada visível nessa escala. No satélite,
 * a foto (e os polígonos do Mapbox que a recortam) aparece a partir daqui; antes, o mapa fica no neutro.
 */
const ZOOM_DETALHE = 5.5

const comFoto = (base: MapaBase) => base === 'satelite' && SATELITE_DISPONIVEL

/** Cores de cada camada do mapa-base, por propriedade de pintura: trocam com o mapa-base sem recarregar o estilo. */
const pinturas = (c: CoresMapa, base: MapaBase): [string, string, string | ExpressionSpecification][] => {
  const s = base === 'satelite' ? SOBRE_SATELITE : null
  return [
    ['terra', 'background-color', c.brasil],
    ['agua', 'fill-color', c.agua],
    ['rios', 'line-color', c.agua],
    ['vias', 'line-color', s?.vias ?? c.vias],
    ['fronteira', 'line-color', c.fronteira],
    ...MASCARAS.map((id): [string, string, string] => [id, 'fill-color', c.fora]),
    ['uf', 'line-color', s?.uf ?? c.uf],
    ['contorno-brasil', 'line-color', s?.fronteira ?? c.fronteira],
    ['fronteira-mapbox', 'line-color', s?.fronteira ?? c.fronteira],
    ['cidades', 'text-color', s?.texto ?? c.textoMapa],
    ['cidades', 'text-halo-color', s?.halo ?? c.halo],
  ]
}

/** Caixa do RS com folga (oeste, sul, leste, norte): fora dela, coberto pela máscara na demo, o MapLibre não pede tiles do Mapbox. */
const LIMITES_SATELITE: [number, number, number, number] = [-58.2, -34.3, -49.1, -26.5]

/**
 * Polígonos de países do próprio Mapbox (Mapbox Countries v1, gratuito, até o zoom 12 e ampliado acima), na visão de
 * mundo `US`, a padrão da documentação. São a máscara da técnica do Mapbox para mostrar a foto de um país só
 * (https://docs.mapbox.com/help/tutorials/style-single-country): os outros países por cima da foto, e a borda do
 * Brasil desenhada com a mesma geometria, para a linha bater com o recorte em qualquer zoom.
 */
const VISAO_DE_MUNDO: ExpressionSpecification = ['any', ['==', ['get', 'worldview'], 'all'], ['in', 'US', ['get', 'worldview']]]

/** As camadas que pintam o que fica fora do Brasil e, na demo do hackathon, fora do RS. */
const MASCARAS = ['mascara', 'mascara-perto', 'mascara-longe', 'mascara-paises', 'mascara-oceano', 'mascara-rs']

/** Só a foto muda com o mapa-base: o recorte do Brasil é o mesmo nos dois (ver `CAMADAS`). */
const visibilidades = (base: MapaBase): [string, boolean][] => [['satelite', comFoto(base)]]

const FONTES: StyleSpecification['sources'] = {
  brasil: { type: 'geojson', data: brasil as unknown as GeoJSONSourceSpecification['data'] },
  rs: { type: 'geojson', data: rs as unknown as GeoJSONSourceSpecification['data'] },
  uf: { type: 'geojson', data: '/geo/uf.json' },
  ofm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
  ...(SATELITE_DISPONIVEL && {
    satelite: {
      type: 'raster',
      tiles: TILES_SATELITE,
      tileSize: 512,
      bounds: LIMITES_SATELITE,
      maxzoom: 22,
      attribution: ATRIBUICAO_SATELITE,
    },
    paises_mapbox: { type: 'vector', tiles: TILES_PAISES, minzoom: 0, maxzoom: 12 },
  }),
}

const parte = (p: string): ExpressionSpecification => ['==', ['get', 'parte'], p]

/** As camadas sem cor: as cores vêm todas de `pinturas`, no estilo inicial e nas trocas de mapa-base. */
const CAMADAS: LayerSpecification[] = [
  // O fundo é a terra do Brasil: o que fica fora dele, as máscaras pintam.
  { id: 'terra', type: 'background' },
  { id: 'agua', type: 'fill', source: 'ofm', 'source-layer': 'water', minzoom: ZOOM_DETALHE },
  {
    id: 'rios',
    type: 'line',
    source: 'ofm',
    'source-layer': 'waterway',
    minzoom: 6,
    paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 2] },
  },
  ...(SATELITE_DISPONIVEL ? ([{ id: 'satelite', type: 'raster', source: 'satelite', minzoom: ZOOM_DETALHE }] as LayerSpecification[]) : []),
  {
    id: 'vias',
    type: 'line',
    source: 'ofm',
    'source-layer': 'transportation',
    minzoom: 6,
    filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'rail'], true, false],
    paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.3, 12, 1.6] },
  },
  // As UFs embaixo das máscaras: a linha simplificada da costa some no mar. Elas somem ao aproximar, onde o desvio da
  // simplificação (até 0,02°) apareceria como uma divisa fora do lugar.
  { id: 'uf', type: 'line', source: 'uf', maxzoom: 10, paint: { 'line-width': 0.7, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 1, 10, 0] } },
  /*
   * Fora do Brasil não aparece nada: as máscaras, por cima do que vem dos tiles, cobrem os vizinhos e o mar. Com o
   * Brasil inteiro na tela vale o contorno das UFs (`mascara`, `contorno-brasil`). Aproximado, esse contorno
   * simplificado cortaria terra do Brasil na costa e nas divisas: o mar sai dos tiles (`mascara-oceano`, preciso) e os
   * vizinhos, com token, dos polígonos do Mapbox (`mascara-paises`, que batem com a foto); longe do Brasil, onde não há
   * tile do Mapbox (`carregarTileMapbox`, em satelite.ts), a máscara local com uma faixa de ~11 km, mais larga que a
   * área onde a foto e os polígonos são pedidos (`mascara-longe`). Sem token, a máscara local com uma faixa de ~3 km,
   * que só cobre o desvio da simplificação (`mascara-perto`), e a borda dos tiles (`fronteira`).
   */
  ...(SATELITE_DISPONIVEL
    ? []
    : ([
        {
          id: 'fronteira',
          type: 'line',
          source: 'ofm',
          'source-layer': 'boundary',
          minzoom: ZOOM_DETALHE,
          // As fronteiras terrestres; as dos vizinhos entre si ficam embaixo das máscaras.
          filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
          paint: { 'line-width': 1.4 },
        },
      ] as LayerSpecification[])),
  { id: 'mascara', type: 'fill', source: 'brasil', filter: parte('fora'), maxzoom: ZOOM_DETALHE },
  ...(SATELITE_DISPONIVEL
    ? ([
        { id: 'mascara-longe', type: 'fill', source: 'brasil', filter: parte('longe'), minzoom: ZOOM_DETALHE },
        {
          id: 'mascara-paises',
          type: 'fill',
          source: 'paises_mapbox',
          'source-layer': 'country_boundaries',
          minzoom: ZOOM_DETALHE,
          // Fora o Brasil e as áreas disputadas que o envolvem (o Rincão de Artigas, `D0BRUY1`, fica por cima do BR).
          filter: ['all', VISAO_DE_MUNDO, ['!', ['in', 'BR', ['get', 'iso_3166_1']]]],
        },
      ] as LayerSpecification[])
    : ([{ id: 'mascara-perto', type: 'fill', source: 'brasil', filter: parte('perto'), minzoom: ZOOM_DETALHE }] as LayerSpecification[])),
  { id: 'mascara-oceano', type: 'fill', source: 'ofm', 'source-layer': 'water', minzoom: ZOOM_DETALHE, filter: ['==', ['get', 'class'], 'ocean'] },
  { id: 'contorno-brasil', type: 'line', source: 'brasil', filter: parte('brasil'), maxzoom: ZOOM_DETALHE, paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 5.5, 1.2] } },
  ...(SATELITE_DISPONIVEL
    ? ([
        {
          id: 'fronteira-mapbox',
          type: 'line',
          source: 'paises_mapbox',
          'source-layer': 'country_boundaries',
          minzoom: ZOOM_DETALHE,
          filter: ['all', VISAO_DE_MUNDO, ['==', ['get', 'iso_3166_1'], 'BR']],
          paint: { 'line-width': 1.4 },
        },
      ] as LayerSpecification[])
    : []),
  // Demo do hackathon: o resto do Brasil some, em qualquer zoom. As camadas do CAR, dos alertas e dos biomas entram
  // abaixo desta (CamadasCar.tsx), e o que passa da divisa some também.
  { id: 'mascara-rs', type: 'fill', source: 'rs', filter: parte('fora') },
  {
    id: 'cidades',
    type: 'symbol',
    source: 'ofm',
    'source-layer': 'place',
    minzoom: ZOOM_DETALHE,
    filter: ['all', ['match', ['get', 'class'], ['city', 'town'], true, false], ['within', DENTRO]],
    layout: {
      'text-field': NOME as never,
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 5.5, 10, 10, 13],
      'text-letter-spacing': 0.04,
    },
    paint: { 'text-halo-width': 1.2 },
  },
]

/**
 * Estilo próprio, plano e só com o Brasil (na demo do hackathon, só com o RS), nas cores do mapa (map/cores.ts; só o que fica fora do Brasil muda com o
 * tema). Com o Brasil inteiro na tela, tudo vem de GeoJSON local (o país, as máscaras e as UFs), então o mapa aparece
 * mesmo sem internet; os tiles vetoriais só acrescentam detalhe.
 * Com token do Mapbox, a imagem de satélite (só no Brasil) fica entre o fundo e as linhas e nomes; o fundo aparece
 * enquanto os tiles carregam.
 */
export function criarEstilo(c: CoresMapa = MAPA, base: MapaBase = 'neutro'): StyleSpecification {
  const pintura = pinturas(c, base)
  const visivel = new Map(visibilidades(base))
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: FONTES,
    layers: CAMADAS.map((layer) => {
      const cores = Object.fromEntries(pintura.filter(([id]) => id === layer.id).map(([, prop, cor]) => [prop, cor]))
      const v = visivel.get(layer.id)
      return {
        ...layer,
        ...('paint' in layer || Object.keys(cores).length ? { paint: { ...layer.paint, ...cores } } : {}),
        ...(v !== undefined && { layout: { ...layer.layout, visibility: v ? 'visible' : 'none' } }),
      } as LayerSpecification
    }),
  }
}

export const estilo = criarEstilo()

/** Camadas de texto do próprio mapa-base (nomes de cidades e localidades). */
export const ROTULOS_NATIVOS = estilo.layers.filter((l) => l.type === 'symbol' && l.layout?.['text-field']).map((l) => l.id)

/** O estilo com a preferência de rótulos, o mapa-base e as cores do tema já aplicados desde o primeiro quadro. */
export function estiloComRotulos(visiveis: boolean, base: MapaBase = 'neutro', c: CoresMapa = MAPA): StyleSpecification {
  const inicial = base === 'neutro' && c === MAPA ? estilo : criarEstilo(c, base)
  return {
    ...inicial,
    layers: inicial.layers.map((layer) => ROTULOS_NATIVOS.includes(layer.id)
      ? { ...layer, layout: { ...layer.layout, visibility: visiveis ? 'visible' : 'none' } }
      : layer),
  }
}

/** Troca o mapa-base e as cores no lugar: recarregar o estilo apagaria as camadas do CAR e dos alertas. */
export function aplicarMapaBase(mapa: MapLibre, base: MapaBase, c: CoresMapa = MAPA) {
  for (const [camada, v] of visibilidades(base)) if (mapa.getLayer(camada)) mapa.setLayoutProperty(camada, 'visibility', v ? 'visible' : 'none')
  for (const [camada, propriedade, cor] of pinturas(c, base)) if (mapa.getLayer(camada)) mapa.setPaintProperty(camada, propriedade, cor)
}
