import type { FeatureCollection, Geometry } from 'geojson'
import type * as C from './contrato'

// Os tipos das respostas da API vêm de ./contrato.ts, gerado dos modelos da API (./run.sh tipos): aqui só os nomes que o
// frontend usa. O OpenAPI não descreve GeoJSON: os campos geométricos usam os tipos do pacote geojson.

export type Status = C.Criterio['status']
export type Coord = [number, number]

export type Saude = C.Saude
export type Regras = C.Regras
/** GET /car/{cod}: a ficha completa, com o contorno em GeoJSON. */
export type ImovelCar = Omit<C.Imovel, 'contorno'> & { contorno: Geometry }
export type VersaoCar = C.VersaoCar
export type AlertaCar = C.AlertaImovel
export type BiomaImovel = C.BiomaImovel
export type ImovelResumo = C.ImovelResumo
export type CamadaAmbiental = C.Camada

// --- imagens históricas ----------------------------------------------------------------------------

export type OpcaoImagemInpe = C.OpcaoInpe
export type OpcaoImagemMapbiomas = C.OpcaoMapbiomas
export type ImagemMapbiomas = C.FotoMapbiomas
export type CasoMapbiomas = C.OpcaoMapbiomas['caso']

interface GeoJsonImagens {
  contorno: Geometry
  alertas: FeatureCollection<Geometry, { alerta: string; detectado_em: string }>
}
type ComGeoJson<T> = Omit<T, keyof GeoJsonImagens> & GeoJsonImagens

/** GET /car/{cod}/imagens?fonte=…: datas de imagem de uma fonte para o imóvel e as sugeridas para comparar. */
export type ImagensImovel = ComGeoJson<C.ImagensInpe> | ComGeoJson<C.ImagensMapbiomas>

// --- seleção para análise e relatórios -------------------------------------------------------------

export type AnaliseCatalogo = C.AnaliseCatalogo
export type ResultadoAnalise = C.ResultadoAnalise
export type BaseRelatorio = C.BaseRelatorio
export type ImovelRelatorio = C.ImovelRelatorio
export type Relatorio = C.Relatorio
export type RelatorioItem = C.RelatorioItem
export type PedidoRelatorio = C.PedidoRelatorio
export type ProvaRelatorio = C.ProvaRelatorio
export type Ancoragem = C.Ancoragem
/** GET /verificacao/{id}: o registro de um relatório na Solana, público. */
export type Verificacao = C.Verificacao
