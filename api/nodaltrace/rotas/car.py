from __future__ import annotations

from fastapi import APIRouter

from ..banco import pool
from ..modelos.car import Imovel, ImovelResumo, PedidoResumo
from ..servicos import imoveis

router = APIRouter(prefix='/car', tags=['CAR'])


@router.post('/resumo', response_model=list[ImovelResumo])
def resumo(pedido: PedidoResumo) -> list[dict]:
    """Ficha curta de vários imóveis (até 500), para listas e destaque no mapa. Usa a versão vigente ou, se o imóvel saiu
    do SICAR, a última; códigos inexistentes ficam de fora. POST: os códigos não cabem numa URL (200 passam de 9 KB)."""
    with pool.connection() as con:
        return imoveis.resumos(con, pedido.cods)


@router.get('/feicao/{feicao}', response_model=ImovelResumo)
def resumo_da_feicao(feicao: int) -> dict:
    """Ficha curta do imóvel de uma feição dos tiles do CAR, que levam só o id (o da versão vigente), não o código."""
    with pool.connection() as con:
        return imoveis.resumo_da_feicao(con, feicao)


@router.get('/{cod_imovel}', response_model=Imovel)
def imovel(cod_imovel: str) -> dict:
    with pool.connection() as con:
        return imoveis.ficha(con, cod_imovel)
