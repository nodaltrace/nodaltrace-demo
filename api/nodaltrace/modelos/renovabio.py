from __future__ import annotations

from typing import Any

from .comum import Modelo


class RegrasRenovabio(Modelo):
    """GET /renovabio/regras: o conjunto de regras do RenovaBio em vigor no motor, para auditoria."""

    regime: str
    versao: str
    minuta: bool
    hash: str
    """SHA-256 do arquivo de regras."""
    rotulo: str
    ato_normativo: str | None
    detalhe_operacional: str | None
    referencias_verificadas: bool
    conteudo: dict[str, Any]
    """O YAML inteiro (regras/renovabio.yaml), com as chaves dele."""
