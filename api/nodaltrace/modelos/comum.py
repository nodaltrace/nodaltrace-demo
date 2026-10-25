"""Tipos que mais de uma resposta usa."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from ..dominio.conformidade import Status

__all__ = ['Criterio', 'Limites', 'Modelo', 'Ponto', 'Status']

#: [oeste, sul, leste, norte] em graus (EPSG:4326).
Limites = tuple[float, float, float, float]
#: [longitude, latitude] em graus (EPSG:4326).
Ponto = tuple[float, float]


class Modelo(BaseModel):
    """Base das respostas: a docstring de cada campo (a string logo abaixo dele) vai para o OpenAPI e, de lá, para os tipos
    do frontend (web/src/api/contrato.ts)."""

    model_config = ConfigDict(use_attribute_docstrings=True)


class Criterio(Modelo):
    """Um critério de conformidade aplicado: o status e a evidência em texto."""

    status: Status
    evidencia: str
