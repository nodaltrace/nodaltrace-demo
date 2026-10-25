import type { MapMouseEvent } from 'maplibre-gl'
import { useEffect, useRef } from 'react'
import { useMap } from 'react-map-gl/maplibre'

const fmt = (x: number) => x.toFixed(5)

/**
 * Latitude e longitude do cursor, embaixo da escala no canto direito do mapa (o "—" quando ele sai). O texto muda direto no DOM, no máximo uma vez por quadro:
 * o mousemove dispara dezenas de vezes por segundo e re-renderizar o React a cada um pesaria no mapa.
 */
export function Coordenadas() {
  const { current } = useMap()
  const ref = useRef<HTMLOutputElement>(null)
  const ultimo = useRef<{ lat: number; lng: number } | null>(null)

  useEffect(() => {
    const mapa = current?.getMap()
    if (!mapa) return
    let quadro = 0
    const escrever = () => {
      quadro = 0
      const p = ultimo.current
      if (ref.current) ref.current.textContent = p ? `${fmt(p.lat)}, ${fmt(p.lng)}` : '—'
    }
    const agendar = () => {
      if (!quadro) quadro = requestAnimationFrame(escrever)
    }
    const mover = (e: MapMouseEvent) => {
      ultimo.current = e.lngLat.wrap()
      agendar()
    }
    const sair = () => {
      ultimo.current = null
      agendar()
    }
    const area = mapa.getCanvasContainer()
    mapa.on('mousemove', mover)
    area.addEventListener('mouseleave', sair)
    return () => {
      mapa.off('mousemove', mover)
      area.removeEventListener('mouseleave', sair)
      cancelAnimationFrame(quadro)
    }
  }, [current])

  // Copiar fica no menu do botão direito: para clicar aqui, o cursor já saiu do ponto.
  return (
    <div className="coordenadas" title="Cursor latitude and longitude (degrees, WGS 84). Right-click the map to copy and more.">
      <span>lat, lon</span>
      <output ref={ref} className="nt-data">—</output>
    </div>
  )
}
