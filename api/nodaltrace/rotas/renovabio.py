from __future__ import annotations

from fastapi import APIRouter

from ..dominio.renovabio import publicacao
from ..modelos.renovabio import RegrasRenovabio

router = APIRouter(prefix='/renovabio', tags=['RenovaBio'])


@router.get('/regras', response_model=RegrasRenovabio)
def regras() -> dict:
    """O conjunto de regras do RenovaBio em vigor no motor, para auditoria. As regras de imóvel (RB-01 e RB-02) entram no
    catálogo de análises (servicos/catalogo.py)."""
    return publicacao()
