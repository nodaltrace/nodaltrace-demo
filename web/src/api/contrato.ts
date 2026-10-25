// Gerado por api/nodaltrace/tipos_ts.py a partir do OpenAPI da API (./run.sh tipos). Não edite: mude os modelos em
// api/nodaltrace/modelos/ e gere de novo.

/** Alerta do MapBiomas que atinge o imóvel (cruzamento alerta × imóvel sobre o CAR carregado). */
export interface AlertaImovel {
  alerta: string
  /** Área do alerta dentro do imóvel. */
  area_ha: number
  /** Área total do alerta; nula se o alerta não estiver na carga de alertas. */
  area_alerta_ha: number | null
  detectado_em: string
  fontes: string[]
  classe: string | null
  /** Detectado depois da data de corte da EUDR (31/12/2020). */
  pos_corte: boolean
  /** Peso no critério EUDR; nulo quando o alerta é anterior ao corte e não conta. */
  status: 'conforme' | 'atencao' | 'pendente' | 'nao_conforme' | null
  /** Retângulo da parte do alerta dentro do imóvel. */
  limites: [number, number, number, number]
}

/** Análise do catálogo. Indisponível enquanto a base dela não estiver carregada. */
export interface AnaliseCatalogo {
  id: string
  nome: string
  descricao: string
  /** Base usada, com a versão carregada; nula se a base não está carregada. */
  base: string | null
  disponivel: boolean
}

export interface AnaliseRelatorio {
  id: string
  nome: string
  descricao: string
  base: string
}

/** O registro do relatório na Solana. */
export interface Ancoragem {
  /** pendente/enviando: ainda não está na rede; confirmada: está; falhou: recusado pela rede (precisa de revisão). */
  status: 'pendente' | 'enviando' | 'confirmada' | 'falhou'
  /** O último erro ao registrar (a tentativa seguinte é automática enquanto o status for pendente). */
  erro: string | null
  tentativas: number
  cluster: string | null
  /** A conta (PDA) da atestação no Solana Attestation Service. */
  conta: string | null
  /** A assinatura da transação que criou a conta. */
  transacao: string | null
  slot: number | null
  /** A hora do bloco em que a conta foi criada. */
  bloco_em: string | null
  confirmada_em: string | null
}

/** O registro dos relatórios na Solana. */
export interface AncoragemSaude {
  /** O attestor está configurado: os relatórios novos vão para a rede. Desligada, ficam pendentes. */
  ligada: boolean
  /** A série dos relatórios deste banco: os números são sequenciais dentro dela. */
  serie: string
  /** Relatórios ainda não confirmados na rede (pendentes ou em envio). */
  pendentes: number
  /** Relatórios que a rede recusou e precisam de revisão. */
  falhas: number
  rede: RedeSolana
}

/** Uma base de dados usada no relatório, com as três datas dela. Nenhuma é a da emissão do relatório. */
export interface BaseRelatorio {
  fonte: 'sicar' | 'mapbiomas' | 'bioma' | 'embargo'
  nome: string
  /** A UF da carga do SICAR; nula nas outras bases. */
  uf: string | null
  versao: string | null
  /** Até onde vão os dados, tirada deles: no SICAR, a atualização mais recente de um imóvel no arquivo; no MapBiomas, o alerta detectado mais recente. Nula quando a base não tem data por registro (biomas). */
  dados_ate: string | null
  /** A data de publicação na fonte, se informada na carga. */
  publicado_em: string | null
  /** Quando a base entrou no banco. */
  carregado_em: string
}

/** Bioma do IBGE que o imóvel atinge, com a área e a fração do imóvel nele. */
export interface BiomaImovel {
  cod: number
  nome: string
  area_ha: number
  fracao: number
}

/** Camada ambiental carregada para cruzamento (MapBiomas, embargos). */
export interface Camada {
  id: number
  tipo: string
  nome: string
  fonte: string
  versao: string
  /** Até onde vão os dados (MapBiomas: a detecção mais recente do arquivo). */
  dados_ate: string | null
  /** A data de publicação na fonte, se informada na carga. */
  publicado_em: string | null
  /** Quando a camada entrou no banco. */
  carregado_em: string
  feicoes: number
}

/** A carga mais recente do SICAR de uma UF. */
export interface CargaCar {
  uf: string
  /** A atualização mais recente de um imóvel no arquivo: até onde vão os dados. */
  dados_ate: string | null
  /** A data de publicação no SICAR, se informada na carga. */
  publicado_em: string | null
  /** Quando a carga entrou no banco. */
  carregado_em: string
}

/** Um critério de conformidade aplicado: o status e a evidência em texto. */
export interface Criterio {
  status: 'conforme' | 'atencao' | 'pendente' | 'nao_conforme'
  evidencia: string
}

export interface FotoMapbiomas {
  data: string | null
  url: string
  constelacao: string | null
}

export interface ImagensInpe {
  /** Texto literal dos créditos da fonte, para mostrar junto da imagem. */
  creditos: string
  /** Cantos das imagens do INPE (o imóvel com uma margem). */
  limites: [number, number, number, number]
  /** Muda com `limites`: vai na URL da imagem (`?v=`), que o navegador guarda como imutável. */
  versao: string
  /** Geometria GeoJSON do imóvel (simplificada). */
  contorno: Record<string, unknown>
  /** FeatureCollection GeoJSON dos alertas no imóvel, com `alerta` e `detectado_em` nas propriedades. */
  alertas: Record<string, unknown>
  fonte: 'sentinel2' | 'cbers4a'
  resolucao_m: number
  opcoes: OpcaoInpe[]
  /** Par sugerido para comparar; nulo sem imagem. */
  sugestao: SugestaoPar | null
}

export interface ImagensMapbiomas {
  /** Texto literal dos créditos da fonte, para mostrar junto da imagem. */
  creditos: string
  /** Cantos das imagens do INPE (o imóvel com uma margem). */
  limites: [number, number, number, number]
  /** Muda com `limites`: vai na URL da imagem (`?v=`), que o navegador guarda como imutável. */
  versao: string
  /** Geometria GeoJSON do imóvel (simplificada). */
  contorno: Record<string, unknown>
  /** FeatureCollection GeoJSON dos alertas no imóvel, com `alerta` e `detectado_em` nas propriedades. */
  alertas: Record<string, unknown>
  fonte: 'mapbiomas'
  resolucao_m: null
  opcoes: OpcaoMapbiomas[]
  sugestao: SugestaoAlerta
}

/** GET /car/{cod_imovel}: a versão que vale do imóvel, o histórico e os critérios sobre ela. */
export interface Imovel {
  cod_imovel: string
  /** Está na carga mais recente do SICAR da UF. */
  vigente: boolean
  uf: string
  municipio: string | null
  cod_ibge: number | null
  area_ha: number | null
  mod_fiscal: number | null
  /** Até 4 módulos fiscais (Lei 12.651/2012). */
  pequena_propriedade: boolean
  /** Código da situação no SICAR (AT, PE, SU, CA). */
  situacao: string | null
  situacao_rotulo: string
  /** A situação no SICAR lida como critério (fora da carga vigente pede revisão). */
  conformidade_car: Criterio
  tipo: string | null
  tipo_rotulo: string | null
  condicao: string | null
  criado_sicar: string | null
  atualizado_sicar: string | null
  limites: [number, number, number, number]
  /** Contorno da versão que vale (GeoJSON, simplificado a ~1 m), para o destaque no mapa em qualquer zoom. */
  contorno: Record<string, unknown>
  versoes: VersaoCar[]
  /** Critério EUDR pelos alertas do MapBiomas; nulo se o MapBiomas não foi carregado. */
  eudr: Criterio | null
  alertas: AlertaImovel[]
  /** Biomas do IBGE no imóvel; nulo se os biomas não foram carregados. */
  biomas: BiomaImovel[] | null
}

export interface ImovelRelatorio {
  cod_imovel: string
  uf: string
  municipio: string | null
  area_ha: number | null
  mod_fiscal: number | null
  situacao: string | null
  vigente: boolean
  versao_car: VersaoCarRelatorio
  limites: [number, number, number, number]
  /** O pior entre as análises que emitem veredito. */
  status: 'conforme' | 'atencao' | 'pendente' | 'nao_conforme'
  resultados: ResultadoAnalise[]
}

/** Ficha curta de um imóvel (POST /car/resumo), para listas e destaque no mapa. */
export interface ImovelResumo {
  cod_imovel: string
  uf: string
  municipio: string | null
  area_ha: number | null
  /** Código da situação no SICAR (AT, PE, SU, CA). */
  situacao: string | null
  situacao_rotulo: string
  /** A situação no SICAR lida como critério. */
  conformidade: 'conforme' | 'atencao' | 'pendente' | 'nao_conforme'
  vigente: boolean
  /** Id do imóvel nos tiles do CAR (o da versão vigente); nulo se o imóvel saiu do SICAR e não está nos tiles. */
  feicao: number | null
  limites: [number, number, number, number]
  /** Um ponto dentro do imóvel, para marcá-lo com o mapa afastado. */
  centro: [number, number]
}

/** Uma data de imagem do INPE (Sentinel-2: trimestre; CBERS-4A: dia). */
export interface OpcaoInpe {
  /** Data (AAAA-MM-DD): a imagem está em GET /car/{cod}/imagens/{fonte}/{id}. */
  id: string
  data: string
  /** 'Jan–Mar 2018' no Sentinel-2, 'Apr 2, 2023' no CBERS-4A. */
  rotulo: string
  cobertura: number
}

/** Um alerta do imóvel com as imagens de antes e depois publicadas pelo MapBiomas, se houver. */
export interface OpcaoMapbiomas {
  id: string
  alerta: string
  detectado_em: string
  /** Cantos das duas imagens; nulo se o alerta está fora da base de imóveis do MapBiomas (imagem sem posição). */
  limites: [number, number, number, number] | null
  antes: FotoMapbiomas | null
  depois: FotoMapbiomas | null
  /** Como o alerta pode ser comparado: no mapa (imagem com os cantos), sem mapa (imagem sem posição) ou não pode (o MapBiomas não publicou imagem dele). */
  caso: 'mapa' | 'sem-mapa' | 'sem-imagem'
  /** Fontes do INPE que podem ter imagem dos dois lados da detecção (atalho do alerta sem imagem). */
  fontes_alternativas: ('sentinel2' | 'cbers4a')[]
}

export interface PassoProva {
  lado: 'esquerda' | 'direita'
  hash: string
}

export interface PedidoProva {
  /** Os imóveis a revelar. O cabeçalho vai sempre. */
  imoveis?: string[]
  /** Revelar também o resumo (veredito e contagem de todos os imóveis). */
  resumo?: boolean
}

export interface PedidoRelatorio {
  imoveis: string[]
  analises: string[]
  /** Id do relatório que este corrige. O corrigido continua guardado e registrado; passa a mostrar o que o substitui. */
  substitui?: string | null
  /** Por que o relatório anterior foi corrigido. Obrigatório com `substitui`. */
  motivo?: string | null
}

export interface PedidoResumo {
  /** Códigos do CAR, em qualquer caixa; repetidos contam uma vez. */
  cods: string[]
}

/** Prova parcial: as folhas reveladas e, para cada uma, os hashes irmãos até a raiz. */
export interface ProvaRelatorio {
  formato: 'NT_RELATORIO_PROVA/1'
  relatorio: string
  raiz: string
  itens: Record<string, unknown>[]
  /** Por folha (`<tipo>:<id>`), os irmãos da folha até a raiz. */
  provas: Record<string, PassoProva[]>
}

/** Onde conferir os registros dos relatórios na Solana. */
export interface RedeSolana {
  cluster: string
  /** Só a origem do RPC (sem caminho nem chave). */
  rpc: string | null
  /** O programa do Solana Attestation Service. */
  programa: string
  /** A identidade pública do NodalTrace na rede: a credencial e o schema derivam dela. */
  autoridade: string | null
  credencial: string | null
  /** A PDA do schema NT_RELATORIO (o nome `schema` sombrearia um método do Pydantic). */
  schema: string | null
}

/** O registro do relatório na Solana, sem os detalhes internos dos erros. */
export interface RegistroPublico {
  status: 'pendente' | 'enviando' | 'confirmada' | 'falhou'
  cluster: string | null
  /** A conta (PDA) da atestação no Solana Attestation Service. */
  conta: string | null
  transacao: string | null
  slot: number | null
  bloco_em: string | null
  confirmada_em: string | null
}

/** GET /analises/regras: os parâmetros de compliance em vigor, calculados e aplicados pela API. */
export interface Regras {
  /** A versão das regras (VERSAO_REGRAS), a mesma do cabeçalho dos relatórios e do registro deles na Solana. */
  versao: string
  corte_eudr: string
  area_min_alerta_ha: number
  biomas: RegrasBioma
  /** Situação do CAR no SICAR lida como critério: o mapa pinta os imóveis por esta tabela. */
  situacoes_car: SituacaoCar[]
  /** Imóvel que saiu da carga vigente do SICAR. */
  car_fora_da_carga: Criterio
  tipos_car: Record<string, string>
}

export interface RegrasBioma {
  regras: Record<string, 'conforme' | 'atencao' | 'pendente' | 'nao_conforme' | null>
  efeito: string
}

export interface RegrasRelatorio {
  /** VERSAO_REGRAS (dominio/conformidade.py); vai também para a rede. */
  versao: string
  /** Os parâmetros das regras de decisão em vigor na emissão (regras/versoes.json registra o hash de cada versão). */
  parametros: Record<string, unknown>
}

/** GET /renovabio/regras: o conjunto de regras do RenovaBio em vigor no motor, para auditoria. */
export interface RegrasRenovabio {
  regime: string
  versao: string
  minuta: boolean
  /** SHA-256 do arquivo de regras. */
  hash: string
  rotulo: string
  ato_normativo: string | null
  detalhe_operacional: string | null
  referencias_verificadas: boolean
  /** O YAML inteiro (regras/renovabio.yaml), com as chaves dele. */
  conteudo: Record<string, unknown>
}

/** O relatório guardado, para ler: as folhas do documento remontadas (sem os sais), com a raiz e o registro na rede. */
export interface Relatorio {
  id: string
  serie: string
  numero: number
  emitido_em: string
  emissor: null
  regras: RegrasRelatorio
  bases: BaseRelatorio[]
  analises: AnaliseRelatorio[]
  substitui: SubstituiRelatorio | null
  /** O pior entre os imóveis. */
  status: 'conforme' | 'atencao' | 'pendente' | 'nao_conforme'
  resumo: ResumoRelatorio
  imoveis: ImovelRelatorio[]
  /** Raiz de Merkle das folhas do documento, em hex: o que está registrado na Solana. */
  raiz: string
  /** A raiz recalculada das folhas guardadas confere com a registrada na emissão. */
  integro: boolean
  substituido_por: SubstituidoPor | null
  ancoragem: Ancoragem
}

export interface RelatorioItem {
  id: string
  numero: number
  emitido_em: string
  status: 'conforme' | 'atencao' | 'pendente' | 'nao_conforme'
  imoveis: number
  analises: number
  ancoragem: 'pendente' | 'enviando' | 'confirmada' | 'falhou'
  substitui: string | null
  substituido_por: string | null
}

export interface ResultadoAnalise {
  analise: string
  /** Nulo: informativo, não entra no veredito. */
  status: 'conforme' | 'atencao' | 'pendente' | 'nao_conforme' | null
  resumo: string
  detalhes: string[]
  /** A evidência por trás do resultado, em dados (ids e áreas dos alertas, situação no SICAR, biomas...), para quem audita conferir na fonte. */
  fatos: Record<string, unknown>
}

/** Quantos imóveis em cada status. */
export interface ResumoRelatorio {
  conforme: number
  atencao: number
  pendente: number
  nao_conforme: number
}

/** GET /saude: a API no ar, as cargas do CAR por UF e o registro dos relatórios na Solana. */
export interface Saude {
  status: 'ok'
  cargas_car: CargaCar[]
  /** Muda quando os tiles mudam (carga ou migração): vai no endereço deles, para o cache. */
  versao_tiles: string
  ancoragem: AncoragemSaude
}

export interface SituacaoCar {
  codigo: string
  rotulo: string
  status: 'conforme' | 'atencao' | 'pendente' | 'nao_conforme'
  evidencia: string
}

export interface SubstituiRelatorio {
  relatorio: string
  numero: number
  motivo: string
}

export interface SubstituidoPor {
  relatorio: string
  emitido_em: string
  motivo: string
}

export interface SugestaoAlerta {
  alerta: string | null
}

export interface SugestaoPar {
  antes: string
  depois: string
  /** Com `?deteccao=`, se a fonte tem imagem dos dois lados dela (falso: a sugestão caiu na mais antiga e na mais recente); nulo sem `?deteccao=`. */
  cerca_deteccao: boolean | null
}

/** Os dados do registro de um relatório, para conferir na rede. Nada dos imóveis nem dos resultados: quem tem o documento (ou uma prova parcial) confere o conteúdo na página de verificação. */
export interface Verificacao {
  relatorio: string
  serie: string
  numero: number
  emitido_em: string
  /** A versão das regras com que o relatório foi feito. */
  regras: string
  /** A raiz de Merkle do documento, registrada na rede. */
  raiz: string
  substitui: string | null
  substituido_por: SubstituidoPor | null
  registro: RegistroPublico
  rede: RedeSolana
}

export interface VersaoCar {
  valido_de: string
  valido_ate: string | null
  situacao: string | null
  area_ha: number | null
  condicao: string | null
  carga_id: number
  /** A situação desta versão lida como critério. */
  conformidade: 'conforme' | 'atencao' | 'pendente' | 'nao_conforme'
}

/** A versão do CAR analisada: desde quando vale no histórico do banco e o hash da linha. */
export interface VersaoCarRelatorio {
  valido_de: string
  hash: string
}
