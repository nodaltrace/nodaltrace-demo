from __future__ import annotations

from datetime import date
from typing import Any

from pydantic import Field

from .comum import Criterio, Limites, Modelo, Ponto, Status

#: Imóveis por pedido de fichas curtas.
MAX_RESUMOS = 500


class PedidoResumo(Modelo):
    cods: list[str] = Field(min_length=1, max_length=MAX_RESUMOS)
    """Códigos do CAR, em qualquer caixa; repetidos contam uma vez."""


class ImovelResumo(Modelo):
    """Ficha curta de um imóvel (POST /car/resumo), para listas e destaque no mapa."""

    cod_imovel: str
    uf: str
    municipio: str | None
    area_ha: float | None
    situacao: str | None
    """Código da situação no SICAR (AT, PE, SU, CA)."""
    situacao_rotulo: str
    conformidade: Status
    """A situação no SICAR lida como critério."""
    vigente: bool
    feicao: int | None
    """Id do imóvel nos tiles do CAR (o da versão vigente); nulo se o imóvel saiu do SICAR e não está nos tiles."""
    limites: Limites
    centro: Ponto
    """Um ponto dentro do imóvel, para marcá-lo com o mapa afastado."""


class VersaoCar(Modelo):
    valido_de: date
    valido_ate: date | None
    situacao: str | None
    area_ha: float | None
    condicao: str | None
    carga_id: int
    conformidade: Status
    """A situação desta versão lida como critério."""


class AlertaImovel(Modelo):
    """Alerta do MapBiomas que atinge o imóvel (cruzamento alerta × imóvel sobre o CAR carregado)."""

    alerta: str
    area_ha: float
    """Área do alerta dentro do imóvel."""
    area_alerta_ha: float | None
    """Área total do alerta; nula se o alerta não estiver na carga de alertas."""
    detectado_em: date
    fontes: list[str]
    classe: str | None
    pos_corte: bool
    """Detectado depois da data de corte da EUDR (31/12/2020)."""
    status: Status | None
    """Peso no critério EUDR; nulo quando o alerta é anterior ao corte e não conta."""
    limites: Limites
    """Retângulo da parte do alerta dentro do imóvel."""


class BiomaImovel(Modelo):
    """Bioma do IBGE que o imóvel atinge, com a área e a fração do imóvel nele."""

    cod: int
    nome: str
    area_ha: float
    fracao: float


class Imovel(Modelo):
    """GET /car/{cod_imovel}: a versão que vale do imóvel, o histórico e os critérios sobre ela."""

    cod_imovel: str
    vigente: bool
    """Está na carga mais recente do SICAR da UF."""
    uf: str
    municipio: str | None
    cod_ibge: int | None
    area_ha: float | None
    mod_fiscal: float | None
    pequena_propriedade: bool
    """Até 4 módulos fiscais (Lei 12.651/2012)."""
    situacao: str | None
    """Código da situação no SICAR (AT, PE, SU, CA)."""
    situacao_rotulo: str
    conformidade_car: Criterio
    """A situação no SICAR lida como critério (fora da carga vigente pede revisão)."""
    tipo: str | None
    tipo_rotulo: str | None
    condicao: str | None
    criado_sicar: date | None
    atualizado_sicar: date | None
    limites: Limites
    contorno: dict[str, Any]
    """Contorno da versão que vale (GeoJSON, simplificado a ~1 m), para o destaque no mapa em qualquer zoom."""
    versoes: list[VersaoCar]
    eudr: Criterio | None
    """Critério EUDR pelos alertas do MapBiomas; nulo se o MapBiomas não foi carregado."""
    alertas: list[AlertaImovel]
    biomas: list[BiomaImovel] | None
    """Biomas do IBGE no imóvel; nulo se os biomas não foram carregados."""
