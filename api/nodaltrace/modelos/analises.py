from __future__ import annotations

from datetime import date, datetime

from .comum import Criterio, Modelo, Status


class Camada(Modelo):
    """Camada ambiental carregada para cruzamento (MapBiomas, embargos)."""

    id: int
    tipo: str
    nome: str
    fonte: str
    versao: str
    dados_ate: date | None
    """Até onde vão os dados (MapBiomas: a detecção mais recente do arquivo)."""
    publicado_em: date | None
    """A data de publicação na fonte, se informada na carga."""
    carregado_em: datetime
    """Quando a camada entrou no banco."""
    feicoes: int


class SituacaoCar(Modelo):
    codigo: str
    rotulo: str
    status: Status
    evidencia: str


class RegrasBioma(Modelo):
    regras: dict[str, Status | None]
    efeito: str


class Regras(Modelo):
    """GET /analises/regras: os parâmetros de compliance em vigor, calculados e aplicados pela API."""

    versao: str
    """A versão das regras (VERSAO_REGRAS), a mesma do cabeçalho dos relatórios e do registro deles na Solana."""
    corte_eudr: date
    area_min_alerta_ha: float
    biomas: RegrasBioma
    situacoes_car: list[SituacaoCar]
    """Situação do CAR no SICAR lida como critério: o mapa pinta os imóveis por esta tabela."""
    car_fora_da_carga: Criterio
    """Imóvel que saiu da carga vigente do SICAR."""
    tipos_car: dict[str, str]
