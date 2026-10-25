from __future__ import annotations

from fastapi import APIRouter

from ..banco import pool
from ..consultas import cargas, relatorios
from ..modelos.saude import Saude
from ..servicos import ancoragem, solana

router = APIRouter(tags=['Saúde'])


@router.get('/saude', response_model=Saude)
def saude() -> dict:
    """A API no ar, a carga mais recente do CAR de cada UF, a versão dos tiles e o registro dos relatórios na Solana."""
    with pool.connection() as con:
        fila = relatorios.fila_da_ancoragem(con)
        return {
            'status': 'ok', 'cargas_car': cargas.car(con), 'versao_tiles': cargas.versao_tiles(con),
            'ancoragem': {'ligada': solana.configurado() and not ancoragem.no_banco_de_testes(), **fila, 'rede': solana.rede()},
        }
