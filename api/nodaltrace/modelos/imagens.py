from __future__ import annotations

from datetime import date
from typing import Annotated, Any, Literal

from pydantic import Field

from .comum import Limites, Modelo

FonteInpe = Literal['sentinel2', 'cbers4a']


class OpcaoInpe(Modelo):
    """Uma data de imagem do INPE (Sentinel-2: trimestre; CBERS-4A: dia)."""

    id: str
    """Data (AAAA-MM-DD): a imagem está em GET /car/{cod}/imagens/{fonte}/{id}."""
    data: date
    rotulo: str
    """'Jan–Mar 2018' no Sentinel-2, 'Apr 2, 2023' no CBERS-4A."""
    cobertura: float


class FotoMapbiomas(Modelo):
    data: date | None
    url: str
    constelacao: str | None


class OpcaoMapbiomas(Modelo):
    """Um alerta do imóvel com as imagens de antes e depois publicadas pelo MapBiomas, se houver."""

    id: str
    alerta: str
    detectado_em: date
    limites: Limites | None
    """Cantos das duas imagens; nulo se o alerta está fora da base de imóveis do MapBiomas (imagem sem posição)."""
    antes: FotoMapbiomas | None
    depois: FotoMapbiomas | None
    caso: Literal['mapa', 'sem-mapa', 'sem-imagem']
    """Como o alerta pode ser comparado: no mapa (imagem com os cantos), sem mapa (imagem sem posição) ou não pode (o MapBiomas não publicou imagem dele)."""
    fontes_alternativas: list[FonteInpe]
    """Fontes do INPE que podem ter imagem dos dois lados da detecção (atalho do alerta sem imagem)."""


class SugestaoPar(Modelo):
    antes: str
    depois: str
    cerca_deteccao: bool | None
    """Com `?deteccao=`, se a fonte tem imagem dos dois lados dela (falso: a sugestão caiu na mais antiga e na mais recente); nulo sem `?deteccao=`."""


class SugestaoAlerta(Modelo):
    alerta: str | None


class _Imagens(Modelo):
    creditos: str
    """Texto literal dos créditos da fonte, para mostrar junto da imagem."""
    limites: Limites
    """Cantos das imagens do INPE (o imóvel com uma margem)."""
    versao: str
    """Muda com `limites`: vai na URL da imagem (`?v=`), que o navegador guarda como imutável."""
    contorno: dict[str, Any]
    """Geometria GeoJSON do imóvel (simplificada)."""
    alertas: dict[str, Any]
    """FeatureCollection GeoJSON dos alertas no imóvel, com `alerta` e `detectado_em` nas propriedades."""


class ImagensInpe(_Imagens):
    fonte: FonteInpe
    resolucao_m: float
    opcoes: list[OpcaoInpe]
    sugestao: SugestaoPar | None
    """Par sugerido para comparar; nulo sem imagem."""


class ImagensMapbiomas(_Imagens):
    fonte: Literal['mapbiomas']
    resolucao_m: None
    opcoes: list[OpcaoMapbiomas]
    sugestao: SugestaoAlerta


#: GET /car/{cod}/imagens?fonte=…: datas de imagem de uma fonte para o imóvel e as sugeridas para comparar.
Imagens = Annotated[ImagensInpe | ImagensMapbiomas, Field(discriminator='fonte')]
