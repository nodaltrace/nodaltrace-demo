import type { Map as MapLibre, StyleSpecification } from 'maplibre-gl'
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { Layer, Map, Source, type ViewState } from 'react-map-gl/maplibre'
import { urlApi } from '../api/cliente'
import { useImagensImovel } from '../api/hooks'
import type { ImagensImovel, OpcaoImagemInpe, OpcaoImagemMapbiomas } from '../api/tipos'
import { BotaoIcone, useDica } from '../components/ui'
import { STATUS } from '../formato'
import { useMapa } from '../store/mapa'
import { usePainel } from '../store/painel'
import { useRota } from '../store/rota'
import { useTema } from '../tema'
import { camera, margemEsquerda } from './camera'
import { coresMapa } from './cores'
import { aplicarMapaBase, estiloComRotulos } from './estilo'
import { fmtDia, NOME_FONTE, notaResolucao, resolverEscolha, type FonteHistorica } from './historico'

/** Escolha de imagens do imóvel na fonte do menu: a listagem, o par escolhido e se a comparação está aberta. */
export function useEscolhaImagens(cod: string) {
  const fonte = useMapa((s) => s.fonteHistorica)
  const c = useMapa((s) => s.comparacao)
  const minha = c?.cod === cod && c.fonte === fonte ? c : null
  const consulta = useImagensImovel(cod, fonte, minha?.deteccao ?? null)
  const dados = consulta.data?.fonte === fonte ? consulta.data : undefined
  const escolha = dados ? resolverEscolha(dados, minha) : null
  return { fonte, consulta, dados, escolha, comparacao: minha }
}

// --- imagem do INPE ----------------------------------------------------------------------------------------------

interface ImagemInpe {
  url: string | null
  /** Resolução real no terreno (X-Resolucao-Metros) e o motivo de ser pior que a da fonte (X-Reducao). */
  metros: number | null
  reducao: string | null
  erro: string | null
}

const SEM_IMAGEM: ImagemInpe = { url: null, metros: null, reducao: null, erro: null }

const ERRO_IMAGEM: Record<number, string> = { 502: 'image unavailable from INPE', 404: 'no image of the property on this date' }

/**
 * Recorte de uma data, pedido por `fetch` (para ler os cabeçalhos de resolução) e entregue ao MapLibre como URL de
 * blob, revogada ao trocar de data e ao fechar. O `?v=` só muda quando muda a geometria do imóvel: a imagem fica no
 * cache do navegador como imutável.
 */
function useImagemInpe(cod: string, fonte: FonteHistorica, opcao: OpcaoImagemInpe | null, versao: string | undefined) {
  const [img, setImg] = useState<ImagemInpe & { chave: string | null }>({ ...SEM_IMAGEM, chave: null })
  const chave = opcao && versao && fonte !== 'mapbiomas' ? `/car/${encodeURIComponent(cod)}/imagens/${fonte}/${opcao.id}?v=${versao}` : null
  useEffect(() => {
    if (!chave) return
    const abort = new AbortController()
    let url: string | null = null
    fetch(urlApi(chave), { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) return setImg({ ...SEM_IMAGEM, chave, erro: ERRO_IMAGEM[r.status] ?? 'failed to load the image' })
        const metros = Number(r.headers.get('X-Resolucao-Metros'))
        const blob = await r.blob()
        url = URL.createObjectURL(blob)
        setImg({ url, chave, metros: Number.isFinite(metros) && metros > 0 ? metros : null, reducao: r.headers.get('X-Reducao'), erro: null })
      })
      .catch(() => { if (!abort.signal.aborted) setImg({ ...SEM_IMAGEM, chave, erro: 'failed to load the image' }) })
    return () => {
      abort.abort()
      if (!url) return
      URL.revokeObjectURL(url)
      // Voltar a esta data antes da próxima carregar não pode reaproveitar a URL revogada.
      const revogada = url
      setImg((i) => (i.url === revogada ? { ...SEM_IMAGEM, chave: null } : i))
    }
  }, [chave])
  // Enquanto a nova data carrega, nada de mostrar a anterior com a legenda nova.
  return { ...(img.chave === chave ? img : SEM_IMAGEM), carregando: !!chave && img.chave !== chave }
}

// --- mapas -------------------------------------------------------------------------------------------------------

/** O mapa neutro do app sem as fontes do Mapbox: a comparação não paga tiles de satélite. */
function estiloSemMapbox(e: StyleSpecification): StyleSpecification {
  const doMapbox = new Set(['satelite', 'paises_mapbox'])
  return {
    ...e,
    sources: Object.fromEntries(Object.entries(e.sources).filter(([id]) => !doMapbox.has(id))),
    layers: e.layers.filter((l) => !('source' in l) || !doMapbox.has(l.source as string)),
  }
}

type Vista = Pick<ViewState, 'longitude' | 'latitude' | 'zoom'>

const CANTOS = ([o, s, l, n]: [number, number, number, number]): [[number, number], [number, number], [number, number], [number, number]] =>
  [[o, n], [l, n], [l, s], [o, s]]

const COR_ALERTA = STATUS.nao_conforme.cor

interface Lado {
  url: string | null
  limites: [number, number, number, number] | null
}

/** Um dos dois mapas: base neutra, a imagem da data e o contorno do imóvel e dos alertas em linha fina. */
function MapaLado({ lado, dados, vista, aoMover, aoCarregar, estilo, brilho, recorte }: {
  lado: Lado
  dados: ImagensImovel | undefined
  vista: Vista
  aoMover: (v: Vista) => void
  aoCarregar?: (m: MapLibre | null) => void
  estilo: StyleSpecification
  /** O `tci` do CBERS-4A sai escuro: a camada sobe o brilho sem mexer nos pixels. */
  brilho: boolean
  recorte?: CSSProperties
}) {
  // O estilo é fixo (trocá-lo apagaria a imagem e as linhas): o tema muda as cores no lugar.
  const [mapa, setMapa] = useState<MapLibre | null>(null)
  const tema = useTema((s) => s.tema)
  useEffect(() => {
    if (mapa) aplicarMapaBase(mapa, 'neutro', coresMapa(tema))
  }, [mapa, tema])
  return (
    <div className="comparacao-lado" style={recorte}>
      <Map
        {...vista}
        pitch={0}
        bearing={0}
        mapStyle={estilo}
        minZoom={3}
        maxZoom={17}
        dragRotate={false}
        pitchWithRotate={false}
        touchPitch={false}
        attributionControl={false}
        onLoad={(e) => {
          e.target.touchZoomRotate.disableRotation()
          setMapa(e.target)
          aoCarregar?.(e.target)
        }}
        onRemove={() => {
          setMapa(null)
          aoCarregar?.(null)
        }}
        onMove={(e) => aoMover({ longitude: e.viewState.longitude, latitude: e.viewState.latitude, zoom: e.viewState.zoom })}
      >
        {dados && (
          <>
            <Source id="alertas" type="geojson" data={dados.alertas}>
              <Layer id="alertas" type="line" paint={{ 'line-color': COR_ALERTA, 'line-width': 1.2, 'line-opacity': 0.9 }} />
            </Source>
            <Source id="contorno" type="geojson" data={dados.contorno}>
              <Layer id="contorno" type="line" paint={{ 'line-color': '#FFFFFF', 'line-width': 1.2, 'line-opacity': 0.9 }} />
            </Source>
          </>
        )}
        {lado.url && lado.limites && (
          <Source id="imagem" type="image" url={lado.url} coordinates={CANTOS(lado.limites)}>
            {/* As linhas por cima: elas vêm antes no JSX, então já existem quando a imagem entra. */}
            <Layer id="imagem" beforeId={dados ? 'alertas' : undefined} type="raster" paint={{ 'raster-fade-duration': 0, ...(brilho && { 'raster-brightness-max': 1, 'raster-contrast': 0.25, 'raster-brightness-min': 0.04 }) }} />
          </Source>
        )}
      </Map>
    </div>
  )
}

// --- divisor ------------------------------------------------------------------------------------------------------

/** Linha vertical com a alça em losango; arrasta com o ponteiro ou com as setas do teclado. `corte` vai de 0 a 1. */
function Divisor({ corte, aoMudar, moldura }: { corte: number; aoMudar: (f: number) => void; moldura: RefObject<HTMLDivElement | null> }) {
  const arrastando = useRef(false)
  const mover = (x: number) => {
    const r = moldura.current?.getBoundingClientRect()
    if (r?.width) aoMudar(Math.min(1, Math.max(0, (x - r.left) / r.width)))
  }
  const ponteiro = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      arrastando.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      mover(e.clientX)
      e.preventDefault()
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => { if (arrastando.current) mover(e.clientX) },
    onPointerUp: () => { arrastando.current = false },
    onPointerCancel: () => { arrastando.current = false },
  }
  const tecla = (e: KeyboardEvent) => {
    const passo = e.shiftKey ? 0.1 : 0.02
    const novo = { ArrowLeft: corte - passo, ArrowRight: corte + passo, Home: 0, End: 1 }[e.key]
    if (novo === undefined) return
    e.preventDefault()
    aoMudar(Math.min(1, Math.max(0, novo)))
  }
  const [dica, balao] = useDica<HTMLButtonElement>('Drag to compare; when focused, the arrow keys also move it', 'cima')
  return (
    <div className="comparacao-divisor" style={{ left: `${corte * 100}%` }} {...ponteiro}>
      <button
        type="button"
        className="comparacao-alca"
        role="slider"
        aria-label="Divider between before and after"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(corte * 100)}
        onKeyDown={tecla}
        {...dica}
      />
      {balao}
    </div>
  )
}

// --- moldura -------------------------------------------------------------------------------------------------------

/** Créditos com os endereços como link (o do MapBiomas pede o endereço do site). */
function Creditos({ texto }: { texto: string }) {
  const partes = texto.split(/(https?:\/\/[^\s·]+)/)
  return (
    <div className="comparacao-creditos">
      {partes.map((p, i) => (i % 2 ? <a key={i} href={p} target="_blank" rel="noopener">{p}</a> : p))}
    </div>
  )
}

const quase = (a: number, b: number) => Math.abs(a - b) < 1e-9

/** Legenda de um lado: "Before · jul–set/2018", com a resolução quando reduzida, ou por que não há imagem. */
function legendaInpe(opcao: OpcaoImagemInpe | null, img: ReturnType<typeof useImagemInpe>): ReactNode {
  if (!opcao) return null
  const nota = img.erro ?? (img.carregando ? 'loading…' : notaResolucao(img.metros, img.reducao))
  return <>{opcao.rotulo}{nota && <small> · {nota}</small>}</>
}

function legendaMapbiomas(alerta: OpcaoImagemMapbiomas | null, lado: 'antes' | 'depois'): ReactNode {
  const imagem = alerta?.[lado]
  if (!alerta) return null
  if (!imagem) return <small>no MapBiomas image</small>
  return <>{imagem.data ? fmtDia(imagem.data) : `alert #${alerta.alerta}`}</>
}

/** Margens da moldura no mapa; à direita, a faixa dos controles (Controles.tsx). */
const MARGEM = 16
const MARGEM_DIREITA = 76

/**
 * Altura do canto inferior direito do mapa principal (escala, coordenadas, logo e créditos): a moldura para acima dele,
 * para os créditos do mapa-base continuarem à vista. Muda com as notas da escala e com os créditos quebrando linha.
 */
function useAlturaCanto() {
  const [altura, setAltura] = useState(0)
  useEffect(() => {
    const canto = camera.principal()?.getContainer().querySelector('.maplibregl-ctrl-bottom-right')
    if (!canto) return
    const obs = new ResizeObserver(() => setAltura(canto.getBoundingClientRect().height))
    obs.observe(canto)
    return () => obs.disconnect()
  }, [])
  return altura
}

function Moldura({ cod, fechar }: { cod: string; fechar: () => void }) {
  const { fonte, consulta, dados, escolha } = useEscolhaImagens(cod)
  const painelAberto = usePainel((s) => s.aberto)
  const larguraPainel = usePainel((s) => s.largura)
  const rotulos = useMapa((s) => s.camadas.rotulosMapa)
  const [estilo] = useState(() => estiloSemMapbox(estiloComRotulos(rotulos, 'neutro', coresMapa(useTema.getState().tema))))
  const moldura = useRef<HTMLDivElement>(null)
  const [corte, setCorte] = useState(0.5)
  const canto = useAlturaCanto()

  // Câmera dos dois lados, a mesma; começa onde o mapa principal está (a moldura cobre a área visível dele).
  const [vista, setVista] = useState<Vista>(() => {
    const m = camera.principal()
    return m ? { longitude: m.getCenter().lng, latitude: m.getCenter().lat, zoom: m.getZoom() } : { longitude: -50, latitude: -15, zoom: 4 }
  })
  const vistaAtual = useRef(vista)
  vistaAtual.current = vista
  const mapaAntes = useRef<MapLibre | null>(null)
  // Conta as cargas do mapa de baixo: ele volta a ser criado depois de uma imagem do MapBiomas sem mapa.
  const [carga, setCarga] = useState(0)

  const inpe = escolha?.tipo === 'inpe' ? escolha : null
  const mb = escolha?.tipo === 'mapbiomas' ? escolha : null
  const imgAntes = useImagemInpe(cod, fonte, inpe?.antes ?? null, dados?.versao)
  const imgDepois = useImagemInpe(cod, fonte, inpe?.depois ?? null, dados?.versao)

  // O mapa principal acompanha quando o movimento para, com a moldura como margem: fica atrás dela no mesmo enquadramento
  // e, ao fechar, onde a comparação parou. A trava contra laço é a comparação dos valores: quem já está no lugar não se move.
  useEffect(() => {
    const t = setTimeout(() => {
      const m = camera.principal()
      const r = moldura.current?.getBoundingClientRect()
      if (!m || !r || (quase(m.getCenter().lng, vista.longitude) && quase(m.getCenter().lat, vista.latitude) && quase(m.getZoom(), vista.zoom))) return
      const c = m.getContainer().getBoundingClientRect()
      const padding = { left: r.left - c.left, top: r.top - c.top, right: c.right - r.right, bottom: c.bottom - r.bottom }
      m.jumpTo({ center: [vista.longitude, vista.latitude], zoom: vista.zoom, padding })
    }, 150)
    return () => clearTimeout(t)
  }, [vista])
  // E a comparação segue o principal quando ele é que se move (arrastado nas bordas, "Ver imóvel"). Um voo dele ainda
  // em curso ao abrir para aqui: senão levaria a comparação junto, para longe do imóvel.
  useEffect(() => {
    const m = camera.principal()
    if (!m) return
    m.stop()
    const seguir = () => {
      const v = vistaAtual.current
      const c = m.getCenter()
      if (quase(c.lng, v.longitude) && quase(c.lat, v.latitude) && quase(m.getZoom(), v.zoom)) return
      setVista({ longitude: c.lng, latitude: c.lat, zoom: m.getZoom() })
    }
    m.on('move', seguir)
    return () => { m.off('move', seguir) }
  }, [])
  // Ao fechar, o principal fica onde a comparação parou (mesmo fechada no meio de um movimento) e volta à margem da
  // câmera: com a da moldura, o "Ver imóvel" seguinte enquadraria diferente.
  useEffect(() => () => {
    const v = vistaAtual.current
    camera.principal()?.jumpTo({ center: [v.longitude, v.latitude], zoom: v.zoom, padding: camera.padding() })
  }, [])

  // Enquadra o imóvel ao abrir e, no MapBiomas, a imagem do alerta a cada alerta escolhido.
  const limitesAlerta = mb?.alerta.limites
  const enquadrar = limitesAlerta ?? dados?.limites
  const chaveEnquadrar = enquadrar?.join(',')
  useEffect(() => {
    if (!enquadrar || !mapaAntes.current) return
    const [o, s, l, n] = enquadrar
    mapaAntes.current.fitBounds([[o, s], [l, n]], { padding: 32, maxZoom: 16, duration: 700 })
  }, [carga, chaveEnquadrar])

  // Esc fecha só quando não é de outra coisa: campo do painel, menu dos controles, menu do mapa ou balão de ajuda.
  useEffect(() => {
    const tecla = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if ((e.target as Element | null)?.closest?.('input, textarea, select')) return
      if (document.querySelector('.controles-pop, .menu-contexto, .info-balao')) return
      fechar()
    }
    addEventListener('keydown', tecla)
    return () => removeEventListener('keydown', tecla)
  }, [fechar])

  const ladoAntes: Lado = mb
    ? { url: mb.caso === 'mapa' ? mb.alerta.antes?.url ?? null : null, limites: mb.alerta.limites }
    : { url: imgAntes.url, limites: dados?.limites ?? null }
  const ladoDepois: Lado = mb
    ? { url: mb.caso === 'mapa' ? mb.alerta.depois?.url ?? null : null, limites: mb.alerta.limites }
    : { url: imgDepois.url, limites: dados?.limites ?? null }

  // Sem mapa: o alerta do MapBiomas tem imagem mas não tem os cantos.
  const semMapa = mb?.caso === 'sem-mapa'
  const aviso = consulta.error
    ? consulta.error.message
    : consulta.isLoading ? `Fetching ${NOME_FONTE[fonte]} images…`
    : !escolha ? `No ${NOME_FONTE[fonte]} images for this property.`
    : mb?.caso === 'sem-imagem' ? `No MapBiomas image for alert #${mb.alerta.alerta}.`
    : semMapa ? 'MapBiomas image has no map position' : null

  const brilho = fonte === 'cbers4a'
  const comum = { dados, vista, aoMover: setVista, estilo, brilho }
  return (
    <div className="comparacao" ref={moldura} style={{ top: MARGEM, right: MARGEM_DIREITA, bottom: MARGEM + canto, left: margemEsquerda(painelAberto, innerWidth, larguraPainel) }} role="region" aria-label="Before and after image comparison">
      {semMapa && mb ? (
        <>
          <div className="comparacao-lado comparacao-foto">{mb.alerta.antes && <img src={mb.alerta.antes.url} alt="Before" />}</div>
          <div className="comparacao-lado comparacao-foto" style={{ clipPath: `inset(0 0 0 ${corte * 100}%)` }}>
            {mb.alerta.depois && <img src={mb.alerta.depois.url} alt="After" />}
          </div>
        </>
      ) : (
        <>
          <MapaLado {...comum} lado={ladoAntes} aoCarregar={(m) => {
            mapaAntes.current = m
            if (m) setCarga((n) => n + 1)
          }} />
          {/* O de depois por cima, recortado: a área recortada não recebe eventos, então cada metade responde ao seu lado. */}
          <MapaLado {...comum} lado={ladoDepois} recorte={{ clipPath: `inset(0 0 0 ${corte * 100}%)` }} />
        </>
      )}
      <Divisor corte={corte} aoMudar={setCorte} moldura={moldura} />
      {dados && <Creditos texto={dados.creditos} />}
      {aviso && <div className="comparacao-aviso">{aviso}</div>}
      <span className="comparacao-legenda comparacao-legenda--antes">
        Before{(mb || inpe) && ' · '}{mb ? legendaMapbiomas(mb.alerta, 'antes') : legendaInpe(inpe?.antes ?? null, imgAntes)}
      </span>
      <span className="comparacao-legenda comparacao-legenda--depois">
        After{(mb || inpe) && ' · '}{mb ? legendaMapbiomas(mb.alerta, 'depois') : legendaInpe(inpe?.depois ?? null, imgDepois)}
      </span>
      <BotaoIcone rotulo="Close comparison (Esc)" lado="esquerda" className="comparacao-fechar" onClick={fechar}>×</BotaoIcone>
    </div>
  )
}

/**
 * Comparação antes/depois de um imóvel do CAR, numa moldura sobre a área visível do mapa: dois mapas leves, um sobre o
 * outro, com a mesma câmera, e o de cima recortado no divisor. Some ao sair do imóvel (voltar, outro detalhe por cima).
 */
export function Comparacao() {
  const c = useMapa((s) => s.comparacao)
  const setComparacao = useMapa((s) => s.setComparacao)
  const rota = useRota((s) => s.rota)
  const noImovel = rota.tela === 'imovel' && rota.cod === c?.cod
  const aberta = !!c?.aberta && noImovel
  useEffect(() => {
    if (c?.aberta && !noImovel) setComparacao({ ...c, aberta: false })
  }, [c, noImovel, setComparacao])
  const [fechar] = useState(() => () => {
    const atual = useMapa.getState().comparacao
    if (atual) useMapa.getState().setComparacao({ ...atual, aberta: false })
  })
  return aberta && c ? <Moldura key={c.cod} cod={c.cod} fechar={fechar} /> : null
}
