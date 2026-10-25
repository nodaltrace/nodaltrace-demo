import type { FeatureCollection, Point } from 'geojson'
import { memo, useEffect, useRef } from 'react'
import { Layer, Source, useMap } from 'react-map-gl/maplibre'
import { useImovel, useRegras, useRelatorio, useResumoImoveis, useSaude } from '../api/hooks'
import type { Regras } from '../api/tipos'
import { ORDEM_STATUS, STATUS } from '../formato'
import { useMapa } from '../store/mapa'
import { montandoSelecao, naAnalise, useRota } from '../store/rota'
import { useSelecao } from '../store/selecao'
import { MAPA } from './cores'
import { COR_BIOMA } from './biomas'

/**
 * Vector tiles do Martin. O MapLibre exige URL absoluta; o Vite repassa /tiles para o Martin. `versao` (GET /saude) muda
 * quando uma carga ou uma migração muda os tiles: com ela no endereço, o navegador e o CDN guardam o tile como imutável.
 */
const tiles = (fonte: string, versao: string) => [`${location.origin}/tiles/${fonte}/{z}/{x}/{y}?v=${versao}`]

const visivel = (sim: boolean) => (sim ? 'visible' : 'none') as 'visible' | 'none'

const RUIM = STATUS.nao_conforme.cor
const NEUTRO = STATUS.pendente.cor

/**
 * Cor de cada imóvel pela situação no SICAR, com a tabela que a API aplica (GET /analises/regras → situacoes_car):
 * o mapa não tem regra própria. Antes de a tabela chegar, todos ficam na cor de pendente.
 */
const corSituacao = (regras: Regras | undefined) =>
  regras?.situacoes_car.length
    ? ['match', ['get', 'status'], ...regras.situacoes_car.flatMap((s) => [s.codigo, STATUS[s.status].cor]), NEUTRO]
    : NEUTRO

// Alertas do MapBiomas: depois do corte da EUDR (`pos_corte`, calculado nos tiles) como não conforme; antes, em cinza.
const COR_ALERTA = ['case', ['get', 'pos_corte'], RUIM, NEUTRO] as const

/**
 * A máscara de fora do RS (demo do hackathon), logo abaixo dos rótulos do estilo: as camadas do CAR, dos alertas e dos
 * biomas ficam abaixo dela, e o que passa da divisa some.
 */
const ANTES = 'mascara-rs'

/** Cor de um imóvel em análise pelo resultado no relatório (`valor`: o status ou ''); sem resultado, a de destaque. */
const corResultado = (valor: unknown, destaque: string) => ['match', valor, ...ORDEM_STATUS.flatMap((s) => [s, STATUS[s].cor]), destaque]
const EM_ANALISE = ['boolean', ['feature-state', 'analise'], false]

const VAZIO: FeatureCollection = { type: 'FeatureCollection', features: [] }

/**
 * Os imóveis em análise ganham ponto, halo e pulso enquanto o polígono é pequeno demais para achar no meio dos outros:
 * somem entre estes dois zooms (no zoom 12, um imóvel de 60 ha já tem uns 50 px).
 */
const DESTAQUE_SOME_DE = 11.5
const DESTAQUE_ATE = 12.5
/** Some aos poucos entre os dois zooms, a partir da opacidade `v`. */
const sumindo = (v: number) => ['interpolate', ['linear'], ['zoom'], DESTAQUE_SOME_DE, v, DESTAQUE_ATE, 0]
/** Um ciclo do pulso (o anel que cresce e apaga em volta de cada ponto), em ms. */
const PERIODO_PULSO = 1600

/**
 * Anima o pulso dos imóveis em análise: a cada quadro, o raio e a opacidade do anel. Só roda com a análise aberta e
 * algum imóvel nela, e não pinta nada com o mapa aproximado além do destaque. Com movimento reduzido no sistema, o anel
 * fica parado.
 */
function PulsoAnalise({ ativo }: { ativo: boolean }) {
  const { current } = useMap()
  useEffect(() => {
    const mapa = current?.getMap()
    if (!ativo || !mapa) return
    const anel = (raio: number, opacidade: number) => {
      if (!mapa.getLayer('analise-pulso')) return
      mapa.setPaintProperty('analise-pulso', 'circle-radius', raio)
      mapa.setPaintProperty('analise-pulso', 'circle-stroke-opacity', sumindo(opacidade))
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      anel(15, 0.7)
      return
    }
    let quadro = 0
    const passo = (t: number) => {
      quadro = requestAnimationFrame(passo)
      if (mapa.getZoom() >= DESTAQUE_ATE) return
      const f = (t % PERIODO_PULSO) / PERIODO_PULSO
      anel(7 + 22 * (1 - (1 - f) ** 2), 0.95 * (1 - f))
    }
    quadro = requestAnimationFrame(passo)
    return () => cancelAnimationFrame(quadro)
  }, [current, ativo])
  return null
}

/**
 * Os imóveis em análise são destacados pelo estado de cada feição (feature-state, pelo id que vem nos tiles): incluir
 * ou retirar um imóvel muda só a cor dele, sem o MapLibre refazer os tiles do CAR, como acontecia ao mudar o filtro de
 * uma camada. `estados`: id da feição → resultado no relatório ('' antes dele).
 */
function EstadoAnalise({ estados }: { estados: Map<number, string> }) {
  const { current } = useMap()
  const aplicados = useRef(new Map<number, string>())
  useEffect(() => {
    const mapa = current?.getMap()
    if (!mapa) return
    const aplicar = () => {
      if (!mapa.getSource('car')) return false
      const antes = aplicados.current
      for (const id of antes.keys()) if (!estados.has(id)) mapa.removeFeatureState({ source: 'car', sourceLayer: 'car', id })
      for (const [id, resultado] of estados) {
        if (antes.get(id) !== resultado) mapa.setFeatureState({ source: 'car', sourceLayer: 'car', id }, { analise: true, resultado })
      }
      aplicados.current = new Map(estados)
      return true
    }
    if (aplicar()) return
    // Aberto direto num endereço da análise, a fonte do CAR ainda não entrou no mapa (o estilo carrega): aplica quando
    // ela entrar. Sem isto, os imóveis só ganhavam o destaque no próximo redesenho do componente.
    const aoEntrar = () => {
      if (aplicar()) mapa.off('sourcedata', aoEntrar)
    }
    mapa.on('sourcedata', aoEntrar)
    return () => {
      mapa.off('sourcedata', aoEntrar)
    }
  })
  return null
}

/**
 * Camadas de referência sobre o mapa: biomas do IBGE por baixo; os polígonos dos imóveis do CAR de perto, só do
 * recorte visível; por cima, os polígonos dos alertas do MapBiomas, com a parte de cada alerta que cai dentro de um
 * imóvel. Os zooms e opacidades vêm dos ajustes do painel.
 */
export const CamadasCar = memo(function CamadasCar() {
  const versao = useSaude().data?.versao_tiles
  const camadas = useMapa((s) => s.camadas)
  const a = useMapa((s) => s.ajustes)
  const rota = useRota((s) => s.rota)
  const corStatus = corSituacao(useRegras().data)
  // O imóvel aberto, pelo contorno da ficha (já consultada pelo painel): aparece em qualquer zoom e com o CAR desligado,
  // sem baixar os tiles do CAR.
  const aberto = useImovel(rota.tela === 'imovel' ? rota.cod : null).data
  const contorno = aberto ? { type: 'Feature' as const, geometry: aberto.contorno, properties: {} } : VAZIO

  // Imóveis da seleção para análise na cor de destaque enquanto se escolhe; os de um relatório, na cor do resultado.
  const selecao = useSelecao((s) => s.imoveis)
  const relatorio = useRelatorio(rota.tela === 'relatorio' ? rota.id : null).data
  const imoveisAnalise = montandoSelecao(rota) ? selecao : rota.tela === 'relatorio' ? relatorio?.imoveis.map((i) => i.cod_imovel) ?? [] : []
  const { porCod } = useResumoImoveis(imoveisAnalise)
  const resultados = new Map(relatorio?.imoveis.map((i) => [i.cod_imovel, i.status]))
  const estados = new Map<number, string>()
  // Um ponto dentro de cada imóvel em análise: antes do zoom dos imóveis, no lugar do polígono; depois, por cima dele até
  // o polígono ficar grande o bastante (DESTAQUE_ATE).
  const pontosAnalise: FeatureCollection<Point, { resultado: string }> = { type: 'FeatureCollection', features: [] }
  for (const cod of imoveisAnalise) {
    const f = porCod.get(cod)
    if (!f) continue
    const resultado = resultados.get(cod) ?? ''
    if (f.feicao !== null) estados.set(f.feicao, resultado)
    pontosAnalise.features.push({ type: 'Feature', properties: { resultado }, geometry: { type: 'Point', coordinates: f.centro } })
  }
  const corAnalise = corResultado(['coalesce', ['feature-state', 'resultado'], ''], MAPA.destaque)
  // As camadas da análise ficam ligadas durante a seleção inteira: ligar e desligar também faria refazer os tiles.
  const verAnalise = visivel(naAnalise(rota))

  // Sem a versão das bases, o endereço dos tiles mudaria quando ela chegasse e o mapa baixaria tudo de novo.
  if (!versao) return null
  return (
    <>
      <Source id="bioma" type="vector" tiles={tiles('bioma', versao)} minzoom={0} maxzoom={14}>
        <Layer
          id="bioma-preenchimento"
          type="fill"
          source-layer="bioma"
          beforeId={ANTES}
          layout={{ visibility: visivel(camadas.biomas) }}
          // Os biomas vêm em pedaços (subdivididos no banco): com antialias, a emenda entre eles vira uma linha. A borda
          // de verdade é a camada de baixo.
          paint={{ 'fill-color': COR_BIOMA as never, 'fill-opacity': a.opacidadeBiomas, 'fill-antialias': false }}
        />
        <Layer
          id="bioma-limite"
          type="line"
          source-layer="bioma_limite"
          beforeId={ANTES}
          layout={{ visibility: visivel(camadas.biomas) }}
          paint={{ 'line-color': MAPA.bordaBioma, 'line-opacity': Math.min(1, a.opacidadeBiomas * 2.5), 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 10, 1.6] }}
        />
      </Source>

      <Source id="car" type="vector" tiles={tiles('car', versao)} minzoom={8} maxzoom={16}>
        <Layer
          id="car-preenchimento"
          type="fill"
          source-layer="car"
          beforeId={ANTES}
          minzoom={a.carDesde}
          layout={{ visibility: visivel(camadas.car) }}
          paint={{ 'fill-color': corStatus as never, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.12 * a.opacidadeCar, 14, 0.22 * a.opacidadeCar] }}
        />
        <Layer
          id="car-contorno"
          type="line"
          source-layer="car"
          beforeId={ANTES}
          minzoom={a.carDesde}
          layout={{ visibility: visivel(camadas.car) }}
          paint={{ 'line-color': corStatus as never, 'line-opacity': 0.7 * a.opacidadeCar, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.3, 14, 1.2] }}
        />
        <Layer
          id="car-analise"
          type="fill"
          source-layer="car"
          beforeId={ANTES}
          minzoom={a.carDesde}
          layout={{ visibility: verAnalise }}
          paint={{ 'fill-color': corAnalise as never, 'fill-opacity': ['case', EM_ANALISE, 0.38, 0] as never }}
        />
        <Layer
          id="car-analise-contorno"
          type="line"
          source-layer="car"
          beforeId={ANTES}
          minzoom={a.carDesde}
          layout={{ visibility: verAnalise }}
          paint={{
            'line-color': corAnalise as never,
            'line-opacity': ['case', EM_ANALISE, 1, 0] as never,
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 3.5],
          }}
        />
      </Source>
      <EstadoAnalise estados={estados} />

      <Source id="imovel-aberto" type="geojson" data={contorno}>
        <Layer id="imovel-aberto" type="line" beforeId={ANTES} paint={{ 'line-color': MAPA.contorno, 'line-width': 2.5 }} />
      </Source>

      {/* Por cima de tudo (sem beforeId), até dos nomes e da máscara: halo, pulso (animado em PulsoAnalise) e ponto. */}
      <Source id="analise-pontos" type="geojson" data={pontosAnalise}>
        <Layer
          id="analise-halo"
          type="circle"
          maxzoom={DESTAQUE_ATE}
          layout={{ visibility: verAnalise }}
          paint={{
            'circle-radius': 16,
            'circle-blur': 0.7,
            'circle-color': corResultado(['get', 'resultado'], MAPA.destaque) as never,
            'circle-opacity': sumindo(0.6) as never,
          }}
        />
        <Layer
          id="analise-pulso"
          type="circle"
          maxzoom={DESTAQUE_ATE}
          layout={{ visibility: verAnalise }}
          paint={{
            'circle-opacity': 0,
            'circle-stroke-width': 3,
            'circle-stroke-color': corResultado(['get', 'resultado'], MAPA.destaque) as never,
          }}
        />
        <Layer
          id="analise-ponto"
          type="circle"
          maxzoom={DESTAQUE_ATE}
          layout={{ visibility: verAnalise }}
          paint={{
            'circle-radius': 6,
            'circle-color': corResultado(['get', 'resultado'], MAPA.destaque) as never,
            'circle-opacity': sumindo(1) as never,
            'circle-stroke-color': MAPA.anel,
            'circle-stroke-width': 2,
            'circle-stroke-opacity': sumindo(1) as never,
          }}
        />
      </Source>
      <PulsoAnalise ativo={naAnalise(rota) && pontosAnalise.features.length > 0} />

      <Source id="alerta" type="vector" tiles={tiles('alerta', versao)} minzoom={5} maxzoom={16}>
        <Layer
          id="alerta-preenchimento"
          type="fill"
          source-layer="alerta"
          beforeId={ANTES}
          minzoom={a.alertaPoligonosDesde}
          layout={{ visibility: visivel(camadas.alertas) }}
          paint={{ 'fill-color': COR_ALERTA as never, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.8 * a.opacidadeAlertas, 12, 0.3 * a.opacidadeAlertas] }}
        />
        <Layer
          id="alerta-contorno"
          type="line"
          source-layer="alerta"
          beforeId={ANTES}
          minzoom={a.alertaPoligonosDesde}
          layout={{ visibility: visivel(camadas.alertas) }}
          paint={{ 'line-color': COR_ALERTA as never, 'line-opacity': a.opacidadeAlertas, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 14, 1.5] }}
        />
        {/* Abaixo do zoom 10, o alerta menor que um pixel chega como ponto (ref.alerta_tiles): uma bolinha da mesma cor. */}
        <Layer
          id="alerta-ponto"
          type="circle"
          source-layer="alerta"
          beforeId={ANTES}
          minzoom={a.alertaPoligonosDesde}
          maxzoom={10}
          filter={['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]] as never}
          layout={{ visibility: visivel(camadas.alertas) }}
          paint={{ 'circle-color': COR_ALERTA as never, 'circle-opacity': 0.8 * a.opacidadeAlertas, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 1.2, 10, 2] }}
        />
      </Source>

      <Source id="car_alerta" type="vector" tiles={tiles('car_alerta', versao)} minzoom={8} maxzoom={16}>
        <Layer
          id="car-alerta"
          type="fill"
          source-layer="car_alerta"
          beforeId={ANTES}
          minzoom={a.carDesde}
          filter={['get', 'pos_corte'] as never}
          layout={{ visibility: visivel(camadas.alertas) }}
          paint={{ 'fill-color': RUIM, 'fill-opacity': 0.65 * a.opacidadeAlertas, 'fill-outline-color': MAPA.contorno }}
        />
      </Source>
    </>
  )
})

/** Camadas em que o clique abre o imóvel. */
export const CAMADAS_CLICAVEIS = ['car-alerta', 'car-preenchimento']
