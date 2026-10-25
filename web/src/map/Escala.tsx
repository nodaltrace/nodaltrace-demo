import { useMapa } from '../store/mapa'
import { ESCALA_SEM_CAMADAS_M, altitudeM, barra, denominador, fmtAltitude, fmtDenominador, fmtDistancia, fmtZoom, semCamadas } from './escalaVista'

/**
 * Onde a câmera está: zoom, altitude e escala, e como as camadas sensíveis ao zoom aparecem agora. Fica no canto
 * inferior direito do mapa, junto das coordenadas do cursor. As notas vêm primeiro: o bloco cresce para cima e os
 * números não saem do lugar quando uma nota entra ou sai.
 */
export function Escala() {
  const { zoom: z, lat, alturaPx } = useMapa((s) => s.vista)
  const a = useMapa((s) => s.ajustes)
  const camadas = useMapa((s) => s.camadas)
  const b = barra(z, lat)
  // Com o mapa afastado demais, nenhuma camada aparece: uma nota só basta.
  const ocultas = semCamadas(z, lat)
  const notas: [string, string, boolean][] = []
  if (ocultas) notas.push(['Reference layers', `hidden at scales of ${fmtDistancia(ESCALA_SEM_CAMADAS_M)} and above`, true])
  if (!ocultas && camadas.alertas)
    notas.push(z < a.alertaPoligonosDesde
      ? ['Alerts', `hidden; polygons from zoom ${fmtZoom(a.alertaPoligonosDesde)}`, true]
      : ['Alerts', 'polygons of all alerts in view', false])
  if (!ocultas && camadas.car)
    notas.push(z < a.carDesde
      ? ['CAR', `properties from zoom ${fmtZoom(a.carDesde)}`, true]
      : ['CAR', 'properties in view', false])
  return (
    // Só as notas são região viva: zoom e altitude mudam a cada quadro e o leitor de tela os anunciaria sem parar.
    <div className="escala">
      {notas.length > 0 && (
        <div className="escala-notas" aria-live="polite">
          {notas.map(([camada, texto, afastado]) => (
            <p key={camada} className={`escala-nota${afastado ? ' escala-nota--afastado' : ''}`}><b>{camada}:</b> {texto}</p>
          ))}
        </div>
      )}
      <div className="escala-linha">
        <span>Zoom <b className="nt-data">{fmtZoom(z)}</b></span>
        <span>Altitude ≈ <b className="nt-data">{fmtAltitude(altitudeM(z, lat, alturaPx))}</b></span>
      </div>
      <div className="escala-linha">
        <span className="escala-barra">
          <i style={{ width: b.px }} />
          <span className="nt-data">{fmtDistancia(b.metros)}</span>
        </span>
        <span className="nt-data">≈ {fmtDenominador(denominador(z, lat))}</span>
      </div>
    </div>
  )
}
