"""Localização das migrações SQL."""

from pathlib import Path


def pasta_migracoes() -> Path:
    return Path(__file__).resolve().parents[1]
