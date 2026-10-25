import type { MapMouseEvent } from 'maplibre-gl'
import { useEffect, useRef, useState } from 'react'
import { useMap } from 'react-map-gl/maplibre'
import { abrirImovel } from '../store/acoes'
import { codDaFeicao } from './feicoes'

const LARGURA = 248
const fmt = (x: number) => x.toFixed(6)

interface Alvo {
  /** Posição do clique no mapa, em pixels do contêiner. */
  x: number
  y: number
  lon: number
  lat: number
  /** Há um imóvel do CAR sob o clique; `car` é o código dele, que chega da API logo depois (os tiles só têm o id). */
  temCar: boolean
  car: string | null
}

/** Menu do botão direito no mapa: copiar as coordenadas do ponto e abrir o imóvel do CAR que está sob o cursor. */
export function MenuContexto() {
  const { current } = useMap()
  const [alvo, setAlvo] = useState<Alvo | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mapa = current?.getMap()
    if (!mapa) return
    const abrir = (e: MapMouseEvent) => {
      e.preventDefault()
      // Só se a camada existe agora (o CAR sai com o mapa afastado): consultar camada ausente é erro no MapLibre.
      const sob = mapa.getLayer('car-preenchimento') ? mapa.queryRenderedFeatures(e.point, { layers: ['car-preenchimento'] }) : []
      const { lng, lat } = e.lngLat.wrap()
      const novo: Alvo = { x: e.point.x, y: e.point.y, lon: lng, lat, temCar: sob.length > 0, car: null }
      setAviso(null)
      setAlvo(novo)
      if (novo.temCar) void codDaFeicao(sob[0]).then((car) => setAlvo((a) => (a === novo ? { ...a, car } : a)))
    }
    const fechar = () => setAlvo(null)
    mapa.on('contextmenu', abrir)
    mapa.on('movestart', fechar)
    return () => {
      mapa.off('contextmenu', abrir)
      mapa.off('movestart', fechar)
    }
  }, [current])

  // Fecha com Esc ou com um clique fora do menu.
  useEffect(() => {
    if (!alvo) return
    const tecla = (e: KeyboardEvent) => e.key === 'Escape' && setAlvo(null)
    const fora = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setAlvo(null)
    }
    addEventListener('keydown', tecla)
    addEventListener('pointerdown', fora, true)
    return () => {
      removeEventListener('keydown', tecla)
      removeEventListener('pointerdown', fora, true)
    }
  }, [alvo])

  if (!alvo || !current) return null
  const area = current.getMap().getContainer()
  // Dentro da área visível: perto da borda, o menu abre para o outro lado.
  const x = Math.max(8, Math.min(alvo.x, area.clientWidth - LARGURA - 8))
  const y = Math.max(8, Math.min(alvo.y, area.clientHeight - (ref.current?.offsetHeight ?? 360) - 8))
  const fazer = (acao: () => void) => () => {
    setAlvo(null)
    acao()
  }

  const copiar = () => {
    navigator.clipboard?.writeText(`${fmt(alvo.lat)}, ${fmt(alvo.lon)}`).then(
      () => setAviso('Copied'),
      () => setAviso("Couldn't copy"),
    )
  }

  return (
    <div ref={ref} className="menu-contexto" role="menu" style={{ left: x, top: y, width: LARGURA }} onContextMenu={(e) => e.preventDefault()}>
      <button type="button" role="menuitem" className="menu-contexto-coord nt-data" onClick={copiar} title="Copy latitude and longitude">
        {fmt(alvo.lat)}, {fmt(alvo.lon)}
        <small>{aviso ?? 'copy'}</small>
      </button>

      {alvo.temCar && (
        <>
          <hr />
          <p className="menu-contexto-titulo nt-data">{alvo.car ?? 'CAR property…'}</p>
          {alvo.car && <Item onClick={fazer(() => abrirImovel(alvo.car!))}>Open CAR property</Item>}
        </>
      )}
    </div>
  )
}

function Item({ icone, onClick, children }: { icone?: React.ReactNode; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="menuitem" className="menu-contexto-item" onClick={onClick}>
      <span className="menu-contexto-ic">{icone}</span>
      {children}
    </button>
  )
}
