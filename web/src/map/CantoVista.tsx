import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useControl } from 'react-map-gl/maplibre'
import { Coordenadas } from './Coordenadas'
import { Escala } from './Escala'

/**
 * Canto inferior direito do mapa: onde a câmera está (escala) e onde o cursor está (coordenadas), num bloco só.
 * Entra como controle do MapLibre, então fica empilhado acima do logo do Mapbox e dos créditos e nunca os cobre,
 * mesmo com os créditos quebrando em mais linhas ou recolhidos em tela estreita.
 */
export function CantoVista() {
  const [el] = useState(() => {
    const d = document.createElement('div')
    d.className = 'maplibregl-ctrl canto-vista'
    return d
  })
  useControl(() => ({ onAdd: () => el, onRemove: () => el.remove() }), { position: 'bottom-right' })
  // O MapLibre põe cada controle novo no topo do canto: o logo do Mapbox, ao trocar para o satélite, ficaria acima
  // do bloco. Ele volta para o topo sempre que o canto muda.
  useEffect(() => {
    const canto = el.parentElement
    if (!canto) return
    const topo = () => { if (canto.firstElementChild !== el) canto.prepend(el) }
    const obs = new MutationObserver(topo)
    obs.observe(canto, { childList: true })
    topo()
    return () => obs.disconnect()
  }, [el])
  return createPortal(<><Escala /><Coordenadas /></>, el)
}
