from __future__ import annotations

import os

from fastapi import APIRouter, Query, Response

from ..banco import pool
from ..consultas import relatorios
from ..erros import Conflito
from ..modelos.relatorios import AnaliseCatalogo, PedidoProva, PedidoRelatorio, ProvaRelatorio, Relatorio, RelatorioItem
from ..servicos import ancoragem, catalogo, emissao, solana
from ..servicos.pdf import pdf_relatorio

router = APIRouter(prefix='/relatorios', tags=['Relatórios'])


@router.get('/analises', response_model=list[AnaliseCatalogo])
def analises() -> list[dict]:
    """Análises do sistema, na ordem do catálogo. As indisponíveis dependem de uma base ainda não carregada."""
    with pool.connection() as con:
        return catalogo.catalogo(con)


@router.post('', status_code=201, response_model=Relatorio)
def emitir(pedido: PedidoRelatorio) -> dict:
    """Emite o relatório (ou a correção de um, com `substitui` e `motivo`). O registro na Solana sai logo depois, em segundo
    plano: a resposta vem com a ancoragem pendente."""
    with pool.connection() as con:
        r = emissao.emitir(con, pedido.imoveis, pedido.analises, pedido.substitui, pedido.motivo)
    # Depois do commit: o trabalhador já acha o relatório na fila.
    ancoragem.acordar()
    return r


@router.get('', response_model=list[RelatorioItem])
def listar(limite: int = Query(10, ge=1, le=100)) -> list[dict]:
    with pool.connection() as con:
        return relatorios.recentes(con, limite)


@router.get('/{rid}', response_model=Relatorio)
def ver(rid: str) -> dict:
    """O relatório guardado. `integro` recalcula a raiz de Merkle das folhas guardadas e compara com a registrada."""
    with pool.connection() as con:
        return emissao.carregar(con, rid)


@router.get('/{rid}/documento', response_class=Response, responses={200: {'content': {'application/json': {}}}})
def documento(rid: str) -> Response:
    """O documento exatamente como guardado (`{"itens": [...]}` em JCS): quem o tem confere a raiz na Solana sozinho."""
    with pool.connection() as con:
        texto = emissao.documento_guardado(con, rid)
    return Response(texto, media_type='application/json',
                    headers={'Content-Disposition': f'attachment; filename="relatorio-{rid}.json"'})


@router.post('/{rid}/prova', response_model=ProvaRelatorio)
def prova(rid: str, pedido: PedidoProva) -> dict:
    """Prova parcial: o cabeçalho e os imóveis pedidos (e o resumo, se pedido), cada um com os hashes até a raiz. Confere
    contra a Solana sem revelar os outros imóveis."""
    with pool.connection() as con:
        return emissao.prova(con, rid, pedido.imoveis, pedido.resumo)


@router.get('/{rid}/pdf', response_class=Response, responses={200: {'content': {'application/pdf': {}}}})
def pdf(rid: str) -> Response:
    with pool.connection() as con:
        r = emissao.carregar(con, rid)
    if not r['integro']:
        raise Conflito(f'The document of report {rid} does not match the root registered at issuance')
    # O endereço público do app (NT_URL_PUBLICA) leva à página de verificação, que vai no PDF com um QR code.
    url = f'{(os.environ.get("NT_URL_PUBLICA") or "http://localhost:5173").rstrip("/")}/verificar/{rid}'
    return Response(pdf_relatorio(r, solana.rede(), url), media_type='application/pdf',
                    headers={'Content-Disposition': f'attachment; filename="relatorio-{rid}.pdf"'})
