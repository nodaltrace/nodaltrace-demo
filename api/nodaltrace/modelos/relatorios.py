"""O relatório de análise. Os modelos `Item*` são exatamente as folhas guardadas (dominio/relatorio.py) e entram na raiz
de Merkle registrada na Solana: mudar um campo deles muda o formato dos relatórios novos (FORMATO)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import Field

from .comum import Limites, Modelo, Status

MAX_IMOVEIS = 200


class PedidoRelatorio(Modelo):
    imoveis: list[str] = Field(min_length=1, max_length=MAX_IMOVEIS)
    analises: list[str] = Field(min_length=1)
    substitui: str | None = None
    """Id do relatório que este corrige. O corrigido continua guardado e registrado; passa a mostrar o que o substitui."""
    motivo: str | None = Field(default=None, min_length=10, max_length=500)
    """Por que o relatório anterior foi corrigido. Obrigatório com `substitui`."""


class PedidoProva(Modelo):
    imoveis: list[str] = Field(default_factory=list, max_length=MAX_IMOVEIS)
    """Os imóveis a revelar. O cabeçalho vai sempre."""
    resumo: bool = False
    """Revelar também o resumo (veredito e contagem de todos os imóveis)."""


class AnaliseCatalogo(Modelo):
    """Análise do catálogo. Indisponível enquanto a base dela não estiver carregada."""

    id: str
    nome: str
    descricao: str
    base: str | None
    """Base usada, com a versão carregada; nula se a base não está carregada."""
    disponivel: bool


class AnaliseRelatorio(Modelo):
    id: str
    nome: str
    descricao: str
    base: str


class ResultadoAnalise(Modelo):
    analise: str
    status: Status | None
    """Nulo: informativo, não entra no veredito."""
    resumo: str
    detalhes: list[str]
    fatos: dict[str, Any]
    """A evidência por trás do resultado, em dados (ids e áreas dos alertas, situação no SICAR, biomas...), para quem
    audita conferir na fonte."""


class VersaoCarRelatorio(Modelo):
    """A versão do CAR analisada: desde quando vale no histórico do banco e o hash da linha."""

    valido_de: date
    hash: str


class BaseRelatorio(Modelo):
    """Uma base de dados usada no relatório, com as três datas dela. Nenhuma é a da emissão do relatório."""

    fonte: Literal['sicar', 'mapbiomas', 'bioma', 'embargo']
    nome: str
    uf: str | None
    """A UF da carga do SICAR; nula nas outras bases."""
    versao: str | None
    dados_ate: date | None
    """Até onde vão os dados, tirada deles: no SICAR, a atualização mais recente de um imóvel no arquivo; no MapBiomas,
    o alerta detectado mais recente. Nula quando a base não tem data por registro (biomas)."""
    publicado_em: date | None
    """A data de publicação na fonte, se informada na carga."""
    carregado_em: datetime
    """Quando a base entrou no banco."""


class ResumoRelatorio(Modelo):
    """Quantos imóveis em cada status."""

    conforme: int
    atencao: int
    pendente: int
    nao_conforme: int


class RegrasRelatorio(Modelo):
    versao: str
    """VERSAO_REGRAS (dominio/conformidade.py); vai também para a rede."""
    parametros: dict[str, Any]
    """Os parâmetros das regras de decisão em vigor na emissão (regras/versoes.json registra o hash de cada versão)."""


class SubstituiRelatorio(Modelo):
    relatorio: str
    numero: int
    motivo: str


# --- as folhas do documento (o que é guardado e entra na raiz) ------------------------------------------------------

class ItemCabecalho(Modelo):
    tipo: Literal['cabecalho']
    id: Literal['cabecalho']
    formato: Literal['NT_RELATORIO/1']
    relatorio: str
    serie: str
    numero: int
    emitido_em: datetime
    emissor: None
    """Quem emitiu: entra com as contas de usuário; até lá, nulo."""
    regras: RegrasRelatorio
    bases: list[BaseRelatorio]
    """As bases usadas, com as datas dos dados: o relatório é de `emitido_em`, mas os dados são de até `dados_ate`."""
    analises: list[AnaliseRelatorio]
    substitui: SubstituiRelatorio | None


class ItemResumo(Modelo):
    tipo: Literal['resumo']
    id: Literal['resumo']
    sal: str
    status: Status
    """O pior entre os imóveis."""
    contagem: ResumoRelatorio
    imoveis: int


class ItemImovel(Modelo):
    tipo: Literal['imovel']
    id: str
    """O código do CAR."""
    sal: str
    uf: str
    municipio: str | None
    area_ha: float | None
    mod_fiscal: float | None
    situacao: str | None
    vigente: bool
    versao_car: VersaoCarRelatorio
    limites: Limites
    status: Status
    """O pior entre as análises que emitem veredito."""
    resultados: list[ResultadoAnalise]


# --- respostas ------------------------------------------------------------------------------------------------------

class ImovelRelatorio(Modelo):
    cod_imovel: str
    uf: str
    municipio: str | None
    area_ha: float | None
    mod_fiscal: float | None
    situacao: str | None
    vigente: bool
    versao_car: VersaoCarRelatorio
    limites: Limites
    status: Status
    """O pior entre as análises que emitem veredito."""
    resultados: list[ResultadoAnalise]


StatusAncoragem = Literal['pendente', 'enviando', 'confirmada', 'falhou']


class Ancoragem(Modelo):
    """O registro do relatório na Solana."""

    status: StatusAncoragem
    """pendente/enviando: ainda não está na rede; confirmada: está; falhou: recusado pela rede (precisa de revisão)."""
    erro: str | None
    """O último erro ao registrar (a tentativa seguinte é automática enquanto o status for pendente)."""
    tentativas: int
    cluster: str | None
    conta: str | None
    """A conta (PDA) da atestação no Solana Attestation Service."""
    transacao: str | None
    """A assinatura da transação que criou a conta."""
    slot: int | None
    bloco_em: datetime | None
    """A hora do bloco em que a conta foi criada."""
    confirmada_em: datetime | None


class SubstituidoPor(Modelo):
    relatorio: str
    emitido_em: datetime
    motivo: str


class Relatorio(Modelo):
    """O relatório guardado, para ler: as folhas do documento remontadas (sem os sais), com a raiz e o registro na rede."""

    id: str
    serie: str
    numero: int
    emitido_em: datetime
    emissor: None
    regras: RegrasRelatorio
    bases: list[BaseRelatorio]
    analises: list[AnaliseRelatorio]
    substitui: SubstituiRelatorio | None
    status: Status
    """O pior entre os imóveis."""
    resumo: ResumoRelatorio
    imoveis: list[ImovelRelatorio]
    raiz: str
    """Raiz de Merkle das folhas do documento, em hex: o que está registrado na Solana."""
    integro: bool
    """A raiz recalculada das folhas guardadas confere com a registrada na emissão."""
    substituido_por: SubstituidoPor | None
    ancoragem: Ancoragem


class RelatorioItem(Modelo):
    id: str
    numero: int
    emitido_em: datetime
    status: Status
    imoveis: int
    analises: int
    ancoragem: StatusAncoragem
    substitui: str | None
    substituido_por: str | None


class PassoProva(Modelo):
    lado: Literal['esquerda', 'direita']
    hash: str


class ProvaRelatorio(Modelo):
    """Prova parcial: as folhas reveladas e, para cada uma, os hashes irmãos até a raiz."""

    formato: Literal['NT_RELATORIO_PROVA/1']
    relatorio: str
    raiz: str
    itens: list[dict[str, Any]]
    provas: dict[str, list[PassoProva]]
    """Por folha (`<tipo>:<id>`), os irmãos da folha até a raiz."""
