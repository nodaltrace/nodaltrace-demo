from __future__ import annotations

from fastapi import APIRouter

from ..banco import pool
from ..consultas import cargas
from ..dominio.conformidade import VERSAO_REGRAS, regras_em_vigor
from ..modelos.analises import Camada, Regras

router = APIRouter(prefix='/analises', tags=['Análises'])


@router.get('/camadas', response_model=list[Camada])
def camadas() -> list[dict]:
    """Camadas ambientais carregadas para cruzamento (vazia até a carga do MapBiomas ou dos embargos)."""
    with pool.connection() as con:
        return cargas.camadas(con)


@router.get('/regras', response_model=Regras)
def regras() -> dict:
    """Parâmetros de compliance em vigor (fixos por enquanto), para o painel mostrar o que vale e o mapa pintar os imóveis."""
    return {**regras_em_vigor(), 'versao': VERSAO_REGRAS}
