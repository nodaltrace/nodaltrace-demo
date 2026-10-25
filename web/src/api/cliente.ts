import { QueryClient, keepPreviousData, useQuery } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false } },
})

export class ErroApi extends Error {
  constructor(
    public status: number,
    mensagem: string,
  ) {
    super(mensagem)
  }
}

type Params = Record<string, string | number | boolean | undefined>

/** Caminho da API para o navegador (o Vite e o nginx repassam /api para o FastAPI); também usado em links de download. */
export function urlApi(caminho: string, params?: Params): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== '') q.set(k, String(v))
  const s = q.toString()
  return `/api${caminho}${s ? `${caminho.includes('?') ? '&' : '?'}${s}` : ''}`
}

/** Texto legível do `detail` da API: mensagem simples ou a lista de erros de validação do FastAPI. */
function mensagemDe(corpo: unknown, status: number, caminho: string): string {
  const d = (corpo as { detail?: unknown } | null)?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d.length)
    return d.map((e) => (typeof e === 'string' ? e : (e?.loc ? `${e.loc.at(-1)}: ` : '') + (e?.msg ?? JSON.stringify(e)))).join(' · ')
  return `${status} on ${caminho}`
}

/** Faz a requisição e devolve o JSON; erro de rede vira status 0, resposta de erro vira `ErroApi` com o `detail`. */
async function requisitar<T>(caminho: string, init?: RequestInit): Promise<T> {
  let r: Response
  try {
    r = await fetch(caminho, init)
  } catch (e) {
    if (init?.signal?.aborted) throw e
    throw new ErroApi(0, 'No connection to the API. Check that it is running and try again.')
  }
  if (!r.ok) throw new ErroApi(r.status, mensagemDe(await r.json().catch(() => null), r.status, caminho))
  return r.json()
}

/** GET na API. `signal`: a consulta substituída (outra busca, componente desmontado) é cancelada. */
export const buscar = <T,>(caminho: string, params?: Params, signal?: AbortSignal) => requisitar<T>(urlApi(caminho, params), { signal })

/** POST com corpo JSON. */
export const enviar = <T,>(caminho: string, corpo: unknown, signal?: AbortSignal) =>
  requisitar<T>(urlApi(caminho), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal })

/** Chave das consultas de `useApi`: quem grava no cache (o relatório recém-emitido) monta a mesma. */
export const chaveApi = (caminho: string, params?: Params) => [caminho, params] as const

/**
 * `manterAnterior`: a resposta anterior fica na tela enquanto a nova carrega. `intervalo`: de quantos em quantos ms
 * refazer o pedido, conforme a última resposta (false: não refaz).
 */
export const useApi = <T,>(
  caminho: string | null,
  params?: Params,
  opcoes?: { manterAnterior?: boolean; staleTime?: number; intervalo?: (dados: T | undefined) => number | false },
) =>
  useQuery({
    queryKey: chaveApi(caminho ?? '', params),
    queryFn: ({ signal }) => buscar<T>(caminho!, params, signal),
    enabled: !!caminho,
    placeholderData: opcoes?.manterAnterior ? keepPreviousData : undefined,
    // Só quando informado: `staleTime: undefined` apagaria o padrão do queryClient (60 s) e toda consulta refaria o
    // pedido a cada componente que a usa.
    ...(opcoes?.staleTime !== undefined && { staleTime: opcoes.staleTime }),
    ...(opcoes?.intervalo && { refetchInterval: (q: { state: { data: T | undefined } }) => opcoes.intervalo!(q.state.data) }),
  })
