import { StrictMode, Suspense, lazy } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { queryClient } from './api/cliente'
import './styles/fonts.css'
import './styles/nodaltrace-ui.css'
// Aplica o tema (data-tema no <html>) antes do primeiro quadro.
import './tema'

// A página pública de verificação não carrega o mapa; cada tela é um chunk separado.
const App = lazy(() => import('./App').then((m) => ({ default: m.App })))
const Verificacao = lazy(() => import('./verificar/Verificacao').then((m) => ({ default: m.Verificacao })))
// /verificar (só o arquivo) ou /verificar/<id do relatório>.
const verificar = /^\/verificar(?:\/([^/]+))?\/?$/.exec(location.pathname)
const idVerificar = verificar?.[1] ? decodeURIComponent(verificar[1]).toUpperCase() : null

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Suspense>{verificar ? <Verificacao id={idVerificar} /> : <App />}</Suspense>
    </QueryClientProvider>
  </StrictMode>,
)
