"""GET /verificacao/{id}: o que qualquer pessoa vê de um relatório, sem login."""

from __future__ import annotations

from datetime import datetime

from .comum import Modelo
from .relatorios import StatusAncoragem, SubstituidoPor
from .saude import RedeSolana


class RegistroPublico(Modelo):
    """O registro do relatório na Solana, sem os detalhes internos dos erros."""

    status: StatusAncoragem
    cluster: str | None
    conta: str | None
    """A conta (PDA) da atestação no Solana Attestation Service."""
    transacao: str | None
    slot: int | None
    bloco_em: datetime | None
    confirmada_em: datetime | None


class Verificacao(Modelo):
    """Os dados do registro de um relatório, para conferir na rede. Nada dos imóveis nem dos resultados: quem tem o
    documento (ou uma prova parcial) confere o conteúdo na página de verificação."""

    relatorio: str
    serie: str
    numero: int
    emitido_em: datetime
    regras: str
    """A versão das regras com que o relatório foi feito."""
    raiz: str
    """A raiz de Merkle do documento, registrada na rede."""
    substitui: str | None
    substituido_por: SubstituidoPor | None
    registro: RegistroPublico
    rede: RedeSolana
