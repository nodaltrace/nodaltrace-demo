from __future__ import annotations

from fastapi import APIRouter

from ..banco import pool
from ..consultas import relatorios
from ..erros import NaoEncontrado
from ..modelos.verificacao import Verificacao
from ..servicos import solana

router = APIRouter(prefix='/verificacao', tags=['Verificação'])

_PUBLICAS = ('status', 'cluster', 'conta', 'transacao', 'slot', 'bloco_em', 'confirmada_em')


@router.get('/{rid}', response_model=Verificacao)
def verificar(rid: str) -> dict:
    """Pública: o número, a série, a emissão, a versão das regras e a raiz do relatório, o registro dele na Solana e onde
    conferi-lo. Nada dos imóveis nem dos resultados."""
    with pool.connection() as con:
        r = relatorios.verificacao(con, rid)
    if not r:
        raise NaoEncontrado(f'Report {rid} not found')
    return {
        **{k: r[k] for k in ('serie', 'numero', 'emitido_em', 'regras', 'raiz', 'substitui')},
        'relatorio': r['id'],
        'substituido_por': ({'relatorio': r['s_relatorio'], 'emitido_em': r['s_emitido_em'], 'motivo': r['s_motivo']}
                            if r['s_relatorio'] else None),
        'registro': {c: r[f'a_{c}'] for c in _PUBLICAS},
        'rede': solana.rede(),
    }
