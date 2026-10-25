import { useQuery } from '@tanstack/react-query'
import { buscar, chaveApi, enviar, queryClient, useApi } from './cliente'
import type { FonteHistorica } from '../map/historico'
import type * as T from './tipos'

const id = (v: string | null | undefined) => (v ? encodeURIComponent(v) : null)

/** Estado da API e cargas do CAR por UF: decide se o app abre e mostra as bases carregadas. */
export const useSaude = () => useApi<T.Saude>('/saude')
/** Camadas ambientais carregadas (MapBiomas): mudam só quando a pipeline roda. */
export const useCamadasAmbientais = () => useApi<T.CamadaAmbiental[]>('/analises/camadas', undefined, { staleTime: Infinity })
/** Regras de compliance em vigor, inclusive a tabela da situação do CAR com que o mapa pinta os imóveis. */
export const useRegras = () => useApi<T.Regras>('/analises/regras', undefined, { staleTime: Infinity })
/** A ficha completa do imóvel; sem código, não consulta. */
export const useImovel = (cod: string | null) => useApi<T.ImovelCar>(cod ? `/car/${id(cod)}` : null)
/**
 * Datas de imagem histórica do imóvel numa fonte, com as sugeridas para comparar (o CBERS-4A leva alguns segundos na
 * primeira vez). `deteccao`: a sugestão cerca esta data (alerta do MapBiomas sem imagem própria).
 */
export const useImagensImovel = (cod: string, fonte: FonteHistorica, deteccao: string | null) =>
  useApi<T.ImagensImovel>(`/car/${id(cod)}/imagens`, { fonte, deteccao: fonte === 'mapbiomas' ? undefined : deteccao ?? undefined })
export const useCatalogoAnalises = () => useApi<T.AnaliseCatalogo[]>('/relatorios/analises', undefined, { staleTime: Infinity })
export const useRelatorios = () => useApi<T.RelatorioItem[]>('/relatorios', { limite: 8 })
/** Enquanto o registro na Solana não sai (o envio é em segundo plano, logo depois da emissão), o relatório é relido. */
const EM_REGISTRO = new Set(['pendente', 'enviando'])
export const useRelatorio = (rid: string | null) =>
  useApi<T.Relatorio>(rid ? `/relatorios/${id(rid)}` : null, undefined, { intervalo: (r) => (r && EM_REGISTRO.has(r.ancoragem.status) ? 4000 : false) })
/**
 * Ficha curta de um código, guardada uma a uma: nula se o código não existe na base. Vale enquanto as bases não mudarem
 * (`versao_tiles` de GET /saude muda a cada carga), então fica no cache sem prazo.
 */
const chaveFicha = (versao: string, cod: string) => ['ficha', versao, cod] as const
queryClient.setQueryDefaults(['ficha'], { gcTime: Infinity, staleTime: Infinity })

/**
 * Ficha curta do imóvel de uma feição dos tiles do CAR, que levam só o id (GET /car/feicao/{id}). A ficha já entra no
 * cache: incluir o imóvel clicado na seleção não pede de novo.
 */
export async function buscarFichaDaFeicao(feicao: number): Promise<T.ImovelResumo> {
  const f = await buscar<T.ImovelResumo>(`/car/feicao/${feicao}`)
  const versao = queryClient.getQueryData<T.Saude>(chaveApi('/saude'))?.versao_tiles
  if (versao) queryClient.setQueryData(chaveFicha(versao, f.cod_imovel), f)
  return f
}

export interface Fichas {
  /** A ficha de cada código pedido; null se o código não existe na base; ausente enquanto carrega. */
  porCod: Map<string, T.ImovelResumo | null>
  carregando: boolean
  erro: Error | null
}

/**
 * Fichas curtas dos imóveis (POST /car/resumo). Cada código é buscado uma vez: incluir um imóvel na seleção pede só ele,
 * e tirar um não pede nada.
 */
export function useResumoImoveis(cods: string[]): Fichas {
  const versao = useSaude().data?.versao_tiles
  const ficha = (cod: string) => (versao ? queryClient.getQueryData<T.ImovelResumo | null>(chaveFicha(versao, cod)) : undefined)
  const faltam = [...new Set(cods)].filter((c) => ficha(c) === undefined).sort()
  const consulta = useQuery({
    queryKey: ['/car/resumo', versao, faltam],
    queryFn: async ({ signal }) => {
      const r = await enviar<T.ImovelResumo[]>('/car/resumo', { cods: faltam }, signal)
      const achadas = new Map(r.map((f) => [f.cod_imovel, f]))
      for (const c of faltam) queryClient.setQueryData(chaveFicha(versao!, c), achadas.get(c) ?? null)
      return r
    },
    enabled: !!versao && faltam.length > 0,
    // As fichas são lidas do cache, não de `data`: sem isto, a chegada delas não redesenharia quem pediu.
    notifyOnChangeProps: ['data', 'error'],
  })
  const porCod = new Map<string, T.ImovelResumo | null>()
  for (const c of cods) {
    const f = ficha(c)
    if (f !== undefined) porCod.set(c, f)
  }
  return { porCod, carregando: faltam.length > 0 && !consulta.error, erro: consulta.error }
}
