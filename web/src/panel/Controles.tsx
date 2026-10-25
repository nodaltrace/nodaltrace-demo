import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRegras } from '../api/hooks'
import { FormaStatus } from '../components/FormaStatus'
import { Icone } from '../components/icones'
import { BotaoIcone, Info } from '../components/ui'
import { ORDEM_STATUS, STATUS, fmtDataAno } from '../formato'
import { BIOMAS } from '../map/biomas'
import { AFASTADO, ESCALA_SEM_CAMADAS_M, fmtDistancia, fmtZoom, semCamadas } from '../map/escalaVista'
import { SATELITE_DISPONIVEL, type MapaBase } from '../map/satelite'
import { FONTES_HISTORICAS } from '../map/historico'
import { AJUSTES_PADRAO, useMapa, type Ajustes, type Camadas } from '../store/mapa'

/** Demo do hackathon: o mapa é só o RS, que tem só estes dois biomas. */
const BIOMAS_DO_RS = new Set(['Atlantic Forest', 'Pampa'])

/** Bases de referência reais: CAR, MapBiomas e biomas. */
const BASES: [keyof Camadas, string][] = [
  ['car', 'CAR properties'],
  ['alertas', 'MapBiomas alerts'],
  ['biomas', 'Biomes (IBGE)'],
]

const MAPAS_BASE: [MapaBase, string][] = [
  ['satelite', 'Satellite'],
  ['neutro', 'Neutral'],
]

type Faixa = { chave: keyof Ajustes; rotulo: string; min: number; max: number; passo: number; formato: (v: number) => string }
const zoom = (v: number) => `zoom ${fmtZoom(v)}`
const pct = (v: number) => `${Math.round(v * 100)}%`

/** Ajustes de exibição. As faixas de zoom respeitam o que o servidor de tiles entrega de cada camada. */
const FAIXAS: { grupo: string; itens: Faixa[] }[] = [
  {
    grupo: 'MapBiomas alerts',
    itens: [
      { chave: 'alertaPoligonosDesde', rotulo: 'Polygons from', min: 5, max: 12, passo: 0.5, formato: zoom },
      { chave: 'opacidadeAlertas', rotulo: 'Opacity', min: 0.2, max: 1, passo: 0.05, formato: pct },
    ],
  },
  {
    grupo: 'CAR',
    itens: [
      { chave: 'carDesde', rotulo: 'Properties from', min: 8, max: 14, passo: 0.5, formato: zoom },
      { chave: 'opacidadeCar', rotulo: 'Property opacity', min: 0.2, max: 2, passo: 0.1, formato: pct },
    ],
  },
  {
    grupo: 'Biomes',
    itens: [{ chave: 'opacidadeBiomas', rotulo: 'Opacity', min: 0.05, max: 0.6, passo: 0.01, formato: pct }],
  },
]

/** Aviso das camadas que somem com o mapa afastado demais (escala ≥ 500 km). */
const AVISO_BASES = `Map zoomed out too far (scale ≥ ${fmtDistancia(ESCALA_SEM_CAMADAS_M)}): reference layers hidden. Zoom in to see them.`

/** Lido como booleano: só re-renderiza quando a vista cruza o limite, não a cada movimento. */
const useSemCamadas = () => useMapa((s) => semCamadas(s.vista.zoom, s.vista.lat))

function Mapa() {
  const mapaBase = useMapa((s) => s.mapaBase)
  const setMapaBase = useMapa((s) => s.setMapaBase)
  const rotulosMapa = useMapa((s) => s.camadas.rotulosMapa)
  const alternar = useMapa((s) => s.alternarCamada)
  const fonteHistorica = useMapa((s) => s.fonteHistorica)
  const setFonteHistorica = useMapa((s) => s.setFonteHistorica)
  return (
    <>
      {/* Sem token do Mapbox não há imagem de satélite: o mapa fica no neutro e a escolha não aparece. */}
      {SATELITE_DISPONIVEL && (
        <div className="segmentado" role="radiogroup" aria-label="Base map">
          {MAPAS_BASE.map(([id, rotulo]) => (
            <button key={id} role="radio" aria-checked={mapaBase === id} className={mapaBase === id ? 'on' : ''} onClick={() => setMapaBase(id)}>
              {rotulo}
            </button>
          ))}
        </div>
      )}
      {/* Com uma fonte só (a demo, sem o INPE), não há o que escolher. */}
      {FONTES_HISTORICAS.length > 1 && (
        <>
          <span className="controles-rotulo">
            Historical imagery
            <Info>Source of the before and after images in the "Compare images" section of a CAR property. The MapBiomas ones are the alert images, still in beta.</Info>
          </span>
          <div className="segmentado segmentado--duas-linhas" role="radiogroup" aria-label="Historical imagery">
            {FONTES_HISTORICAS.map(({ id, nome, detalhe }) => (
              <button key={id} role="radio" aria-checked={fonteHistorica === id} className={fonteHistorica === id ? 'on' : ''} onClick={() => setFonteHistorica(id)}>
                {nome}
                <small>{detalhe}</small>
              </button>
            ))}
          </div>
        </>
      )}
      <label>
        <input type="checkbox" checked={rotulosMapa} onChange={() => alternar('rotulosMapa')} />
        City names and map labels
      </label>
    </>
  )
}

/**
 * Caixas de marcar das bases de referência, conforme `AFASTADO`. Com o mapa afastado demais, as camadas ocultas ficam
 * desmarcadas e travadas (a escolha fica guardada mas não vale), com o aviso acima.
 */
function ListaCamadas({ itens, aviso }: { itens: [keyof Camadas, string][]; aviso: string }) {
  const camadas = useMapa((s) => s.camadas)
  const alternar = useMapa((s) => s.alternarCamada)
  const afastado = useSemCamadas()
  const afetado = afastado && itens.some(([id]) => AFASTADO.ocultas.has(id))
  return (
    <>
      {afetado && <p className="controles-nota">{aviso}</p>}
      <div className="camadas-lista">
        {itens.map(([id, rotulo]) => {
          const oculta = afastado && AFASTADO.ocultas.has(id)
          return (
            <label key={id} className={oculta ? 'oculta' : undefined}>
              <input type="checkbox" checked={!oculta && camadas[id]} disabled={oculta} onChange={() => alternar(id)} />
              {rotulo}
            </label>
          )
        })}
      </div>
    </>
  )
}

function Bases() {
  const car = useMapa((s) => s.camadas.car)
  const alertas = useMapa((s) => s.camadas.alertas)
  const biomas = useMapa((s) => s.camadas.biomas)
  const regras = useRegras().data
  return (
    <>
      <ListaCamadas itens={BASES} aviso={AVISO_BASES} />
      {/* A cor de cada situação do CAR é a do status que a API dá a ela (GET /analises/regras). Na demo do hackathon o
          banco só tem imóveis ativos (deploy/demo/reduzir.sh): a legenda mostra só essa situação. */}
      {car && regras && (
        <div className="legenda-grupo">
          {regras.situacoes_car.filter((s) => s.codigo === 'AT').map((s) => (
            <span key={s.codigo} className="legenda"><i className="amostra" style={{ background: STATUS[s.status].cor }} />{s.rotulo} CAR</span>
          ))}
        </div>
      )}
      {alertas && (
        <div className="legenda-grupo">
          <span className="legenda"><i className="amostra" style={{ background: STATUS.nao_conforme.cor }} />Alert after the EUDR cutoff</span>
          <span className="legenda"><i className="amostra" style={{ background: STATUS.pendente.cor }} />Only before the cutoff (doesn't count)</span>
        </div>
      )}
      {biomas && (
        <div className="legenda-grupo">
          {BIOMAS.filter(([nome]) => BIOMAS_DO_RS.has(nome)).map(([nome, cor]) => (
            <span key={nome} className="legenda"><i className="amostra" style={{ background: cor }} />{nome}</span>
          ))}
        </div>
      )}
    </>
  )
}

const useAjustesMudaram = () =>
  useMapa((s) => (Object.keys(AJUSTES_PADRAO) as (keyof Ajustes)[]).some((k) => s.ajustes[k] !== AJUSTES_PADRAO[k]))

function AjustesMapa() {
  const a = useMapa((s) => s.ajustes)
  const setAjuste = useMapa((s) => s.setAjuste)
  const restaurar = useMapa((s) => s.restaurarAjustes)
  const mudou = useAjustesMudaram()
  return (
    <div className="ajustes">
      {FAIXAS.map(({ grupo, itens }) => (
        <fieldset key={grupo}>
          <legend>{grupo}</legend>
          {itens.map((f) => (
            <label key={f.chave} className="faixa">
              <span>{f.rotulo} <b className="nt-data">{f.formato(a[f.chave])}</b></span>
              <input
                type="range" min={f.min} max={f.max} step={f.passo} value={a[f.chave]}
                onChange={(e) => setAjuste(f.chave, Number(e.target.value))}
              />
            </label>
          ))}
        </fieldset>
      ))}
      <button className="nt-btn nt-btn--outline nt-btn--sm" onClick={restaurar} disabled={!mudou}>Restore defaults</button>
    </div>
  )
}

/** Regras de compliance em vigor: só leitura, para o usuário saber o que está valendo. Vêm da API, que as aplica. */
function Regras() {
  const { data: r, error } = useRegras()
  if (!r) return <p className="controles-nota">{error ? 'Rules unavailable: the API did not respond.' : 'Loading…'}</p>
  return (
    <div className="regras">
      <dl>
        <div><dt>EUDR cutoff</dt><dd>{fmtDataAno(r.corte_eudr)}</dd></div>
        <div><dt>Failing alert</dt><dd>≥ {r.area_min_alerta_ha.toLocaleString('en-US')} ha within the property</dd></div>
        {/* Demo do hackathon: o banco só tem imóveis ativos, então só a regra deles; as outras situações distrairiam. */}
        <div><dt>CAR status</dt><dd>{r.situacoes_car.filter((s) => s.codigo === 'AT').map((s) => `${s.rotulo.toLowerCase()}: ${STATUS[s.status].rotulo.toLowerCase()}`).join(' · ')}</dd></div>
        <div><dt>Biome</dt><dd>{r.biomas.efeito === 'informational' ? 'informational, no effect' : r.biomas.efeito}</dd></div>
      </dl>
    </div>
  )
}

function Legenda() {
  return (
    <>
      {ORDEM_STATUS.map((s) => (
        <span key={s} className="legenda">
          <FormaStatus status={s} tamanho={13} />
          {STATUS[s].rotulo}
        </span>
      ))}
    </>
  )
}

type Categoria = 'mapa' | 'bases' | 'ajustes' | 'regras' | 'legenda'

/** Uma categoria por botão. `info` vai num balão ao lado do título. */
const CATEGORIAS: { id: Categoria; rotulo: string; icone: () => ReactNode; conteudo: () => ReactNode; info?: string }[] = [
  { id: 'mapa', rotulo: 'Map', icone: Icone.mapa, conteudo: () => <Mapa /> },
  { id: 'bases', rotulo: 'Reference layers', icone: Icone.camadas, conteudo: () => <Bases /> },
  { id: 'ajustes', rotulo: 'Display settings', icone: Icone.ajustes, conteudo: () => <AjustesMapa />, info: 'Saved in this browser.' },
  { id: 'regras', rotulo: 'Compliance rules', icone: Icone.regras, conteudo: () => <Regras />, info: 'Fixed for now: they apply to the whole app and to every report.' },
  { id: 'legenda', rotulo: 'Compliance legend', icone: Icone.legenda, conteudo: () => <Legenda /> },
]

/**
 * Controles à direita do mapa: uma faixa de botões, um por categoria, e só a categoria escolhida aberta ao lado.
 * Fecha no mesmo botão, com Esc ou com um clique no mapa (arrastar o mapa não fecha).
 */
/**
 * Demo do hackathon: o mapa é só o RS (deploy/demo/reduzir.sh). O aviso fica sempre à vista, acima da categoria aberta;
 * só sai com a comparação de imagens aberta, que ocupa este canto do mapa.
 */
function AvisoDemo() {
  return (
    <aside className="caixa aviso-demo" aria-label="About this demo">
      <strong>Demo: RS State only</strong>
      <p>
        NodalTrace is built for all of Brazil. However, to lower deployment cost for this demo, it loads just one of its
        27 states.
      </p>
    </aside>
  )
}

export function Controles() {
  const [aberta, setAberta] = useState<Categoria | null>(null)
  const comparando = useMapa((s) => !!s.comparacao?.aberta)
  const raiz = useRef<HTMLDivElement>(null)
  const ajustesMudaram = useAjustesMudaram()

  useEffect(() => {
    if (!aberta) return
    let inicio: { x: number; y: number } | null = null
    const dentro = (e: Event) => raiz.current?.contains(e.target as Node) ?? false
    const tecla = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Com o foco dentro da categoria, ele volta para o botão dela.
      if (dentro(e)) raiz.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus()
      setAberta(null)
    }
    const desce = (e: PointerEvent) => { inicio = dentro(e) ? null : { x: e.clientX, y: e.clientY } }
    const sobe = (e: PointerEvent) => {
      if (inicio && Math.hypot(e.clientX - inicio.x, e.clientY - inicio.y) < 5) setAberta(null)
      inicio = null
    }
    addEventListener('keydown', tecla)
    addEventListener('pointerdown', desce, true)
    addEventListener('pointerup', sobe, true)
    return () => {
      removeEventListener('keydown', tecla)
      removeEventListener('pointerdown', desce, true)
      removeEventListener('pointerup', sobe, true)
    }
  }, [aberta])

  const atual = CATEGORIAS.find((c) => c.id === aberta)
  return (
    <div className="controles" ref={raiz}>
      <div className="controles-faixa" role="group" aria-label="Map controls">
        {CATEGORIAS.map(({ id, rotulo, icone: I }) => {
          const mudou = id === 'ajustes' && ajustesMudaram
          return (
            <BotaoIcone
              key={id}
              rotulo={mudou ? `${rotulo} (changed from defaults)` : rotulo}
              lado="esquerda"
              className={aberta === id ? 'on' : ''}
              aria-expanded={aberta === id}
              aria-controls={aberta === id ? `controles-${id}` : undefined}
              onClick={() => setAberta((a) => (a === id ? null : id))}
            >
              <I />
              {mudou && <i className="aba-ponto" aria-hidden />}
            </BotaoIcone>
          )
        })}
      </div>
      <div className="controles-pilha">
        {!comparando && <AvisoDemo />}
        {atual && (
          <section id={`controles-${atual.id}`} className="caixa controles-pop" aria-label={atual.rotulo}>
            <h4>{atual.rotulo}{atual.info && <Info>{atual.info}</Info>}</h4>
            {atual.conteudo()}
          </section>
        )}
      </div>
    </div>
  )
}
