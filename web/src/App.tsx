import { useSaude } from './api/hooks'
import { ComoSubirApi } from './components/ComoSubirApi'
import { MapView } from './map/MapView'
import { Controles } from './panel/Controles'
import { Painel } from './panel/Painel'
import './styles/app.css'
import { Marca } from './components/Marca'

/** O app depende da API: sem ela, explica como subir o ambiente em vez de mostrar telas vazias. */
function SemApi({ erro }: { erro: Error }) {
  return (
    <div className="sem-api">
      <Marca />
      <h1>The API is not responding</h1>
      <ComoSubirApi />
      <p className="nt-data">{erro.message}</p>
    </div>
  )
}

export function App() {
  const { data, error } = useSaude()
  if (error && !data) return <div className="nt app"><SemApi erro={error} /></div>
  return (
    <div className="nt app">
      <MapView />
      <Painel />
      <Controles />
    </div>
  )
}
