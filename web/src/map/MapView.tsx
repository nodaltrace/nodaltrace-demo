import 'maplibre-gl/dist/maplibre-gl.css'
import maplibregl, { addProtocol, type Map as MapLibre } from 'maplibre-gl'
import { useEffect, useRef, useState } from 'react'
import { Map, useControl } from 'react-map-gl/maplibre'
import { abrirImovel } from '../store/acoes'
import { useMapa } from '../store/mapa'
import { usePainel } from '../store/painel'
import { montandoSelecao, useRota } from '../store/rota'
import { useSelecao } from '../store/selecao'
import { useTema } from '../tema'
import { VISTA_INICIAL, ZOOM_MAXIMO, camera, margemEsquerda, prenderNoRS } from './camera'
import { coresMapa } from './cores'
import { gravarHash, lerHash } from './hashMapa'
import { semCamadas } from './escalaVista'
import { ROTULOS_NATIVOS, aplicarMapaBase, estiloComRotulos } from './estilo'
import { CAMADAS_CLICAVEIS, CamadasCar } from './CamadasCar'
import { codDaFeicao } from './feicoes'
import { PROTOCOLO, SATELITE_DISPONIVEL, carregarTileMapbox } from './satelite'
import { CantoVista } from './CantoVista'
import { MenuContexto } from './MenuContexto'
import { Comparacao } from './Comparacao'

// Tiles do Mapbox (foto e polígonos de países) só onde tocam o Brasil: o resto da caixa nem sai do navegador.
if (SATELITE_DISPONIVEL) addProtocol(PROTOCOLO, (p, abort) => carregarTileMapbox(p.url, abort))

/** Logo do Mapbox, exigido junto dos tiles dele. Fica acima dos créditos: o canto esquerdo do mapa é coberto pelo painel. */
function LogoMapbox() {
  useControl(() => {
    const a = document.createElement('a')
    a.className = 'maplibregl-ctrl logo-mapbox'
    a.href = 'https://www.mapbox.com/'
    a.target = '_blank'
    a.rel = 'noopener'
    a.setAttribute('aria-label', 'Mapbox')
    return { onAdd: () => a, onRemove: () => a.remove() }
  }, { position: 'bottom-right' })
  return null
}

/** Os textos dos controles do próprio MapLibre (o ⓘ dos créditos recolhidos). */
const LOCALE = { 'AttributionControl.ToggleAttribution': 'Show or hide credits', 'AttributionControl.MapFeedback': 'Improve this map' }

/** Onde o mapa abre: o enquadramento da URL (#zoom/lat/lon), se houver, ou o Brasil inteiro. */
const VISTA_DA_URL = lerHash(location.hash) ?? VISTA_INICIAL

export function MapView() {
  const painelAberto = usePainel((s) => s.aberto)
  const larguraPainel = usePainel((s) => s.largura)
  const abertoAntes = useRef(painelAberto)
  const setVista = useMapa((s) => s.setVista)
  const rotulosMapa = useMapa((s) => s.camadas.rotulosMapa)
  const mapaBase = useMapa((s) => s.mapaBase)
  // Com a escala em 500 km ou mais, nenhuma base de referência aparece.
  const afastado = useMapa((s) => semCamadas(s.vista.zoom, s.vista.lat))
  const [carregado, setCarregado] = useState(false)
  const [cursor, setCursor] = useState('')
  // Estilo fixo: trocá-lo faria o MapLibre remover e recarregar todas as camadas do CAR e dos alertas.
  const [estilo] = useState(() => {
    const s = useMapa.getState()
    return estiloComRotulos(s.camadas.rotulosMapa, s.mapaBase, coresMapa(useTema.getState().tema))
  })
  const mapaGl = useRef<MapLibre | null>(null)
  const mostrarCamadas = carregado && !afastado
  const clicaveis = mostrarCamadas ? CAMADAS_CLICAVEIS : []

  useEffect(() => {
    // Abrir e fechar o painel anima o mapa junto; arrastar a borda do painel o leva na hora.
    const animar = abertoAntes.current !== painelAberto
    abertoAntes.current = painelAberto
    camera.definirMargem(margemEsquerda(painelAberto, innerWidth, larguraPainel), animar ? 300 : 0)
  }, [painelAberto, larguraPainel])

  // Nomes de cidades do mapa-base: ligam e desligam sem recarregar o estilo.
  useEffect(() => {
    if (!carregado || !mapaGl.current) return
    for (const id of ROTULOS_NATIVOS) mapaGl.current.setLayoutProperty(id, 'visibility', rotulosMapa ? 'visible' : 'none')
  }, [carregado, rotulosMapa])

  // A escolha entre satélite e neutro troca o mapa-base no lugar, e o tema, a cor de fora do Brasil. Com a comparação de
  // imagens aberta, o mapa fica no neutro: ele acompanha a câmera dela, quase todo coberto pela moldura, e não deve pedir
  // a foto do Mapbox.
  const comparando = useMapa((s) => !!s.comparacao?.aberta)
  const base = comparando ? 'neutro' : mapaBase
  const tema = useTema((s) => s.tema)
  useEffect(() => {
    if (carregado && mapaGl.current) aplicarMapaBase(mapaGl.current, base, coresMapa(tema))
  }, [carregado, base, tema])

  return (
    <div className="mapa">
      <Map
        // O módulo já carregado: sem ele, o react-map-gl o importaria de novo num chunk à parte, mais um passo na subida.
        mapLib={maplibregl}
        initialViewState={{ ...VISTA_DA_URL, padding: camera.padding() }}
        mapStyle={estilo}
        // Plano e, na demo do hackathon, só o RS: a câmera não sai dele nem afasta além de ele caber inteiro na área visível.
        transformConstrain={prenderNoRS}
        // 17: a foto do Mapbox ainda tem detalhe próprio; o 18 só amplia o 17 (medido em 6 imóveis de MT, PA e RS).
        maxZoom={ZOOM_MAXIMO}
        dragRotate={false}
        pitchWithRotate={false}
        // Créditos abertos; o MapLibre só os recolhe em mapa estreito (até 640 px), como pedem os termos dos tiles.
        attributionControl={{}}
        locale={LOCALE}
        onLoad={(e) => {
          camera.registrar(e.target)
          mapaGl.current = e.target
          // O enquadramento pode vir da URL (#zoom/lat/lon): o estado parte do zoom real do mapa.
          setVista({ zoom: e.target.getZoom(), lat: e.target.getCenter().lat, alturaPx: e.target.getContainer().clientHeight })
          setCarregado(true)
        }}
        onRemove={() => {
          camera.registrar(null)
          mapaGl.current = null
          setCarregado(false)
        }}
        // Zoom e latitude do centro alimentam a escala e a altitude mostradas no canto do mapa. A altura do mapa só muda
        // no redimensionamento: lê-la a cada quadro forçaria o navegador a recalcular o layout no meio da animação.
        onMove={(e) => setVista({ zoom: e.viewState.zoom, lat: e.viewState.latitude, alturaPx: useMapa.getState().vista.alturaPx })}
        // #zoom/lat/lon na URL: dá para compartilhar ou reabrir um enquadramento.
        onMoveEnd={(e) => gravarHash(e.viewState)}
        onResize={(e) => setVista({ ...useMapa.getState().vista, alturaPx: e.target.getContainer().clientHeight })}
        // Com o mapa afastado demais, as camadas do CAR saem dele: consultar camada inexistente é erro no MapLibre.
        interactiveLayerIds={clicaveis}
        // O clique só seleciona: a câmera fica onde o usuário deixou.
        onClick={(e) => {
          if (!mostrarCamadas || semCamadas(e.target.getZoom(), e.target.getCenter().lat)) return
          void codDaFeicao(e.features?.[0]).then((cod) => {
            if (!cod) return
            // Montando a seleção para análise, o clique inclui ou retira o imóvel em vez de abrir o detalhe.
            if (montandoSelecao(useRota.getState().rota)) useSelecao.getState().alternar(cod)
            else abrirImovel(cod)
          })
        }}
        cursor={clicaveis.length ? cursor : ''}
        onMouseEnter={() => setCursor('pointer')}
        onMouseLeave={() => setCursor('')}
      >
        {base === 'satelite' && SATELITE_DISPONIVEL && <LogoMapbox />}
        {mostrarCamadas && <CamadasCar />}
        {carregado && <MenuContexto />}
        {carregado && <CantoVista />}
      </Map>
      {carregado && <Comparacao />}
    </div>
  )
}
