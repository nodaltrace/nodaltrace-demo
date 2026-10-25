"""Erros que as camadas levantam, cada um com o status HTTP que vira (main.py traduz para {"detail": ...}). Consultas,
serviços e rotas usam só estes: nenhuma camada abaixo das rotas conhece o FastAPI."""

from __future__ import annotations


class ErroApi(Exception):
    status = 500

    def __init__(self, detalhe: str):
        super().__init__(detalhe)
        self.detalhe = detalhe


class NaoEncontrado(ErroApi):
    status = 404


class PedidoInvalido(ErroApi):
    status = 422


class Conflito(ErroApi):
    status = 409


class FonteIndisponivel(ErroApi):
    """Uma fonte externa (INPE, MapBiomas) não respondeu como esperado."""

    status = 502
