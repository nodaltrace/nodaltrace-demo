from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import Field

from .comum import Modelo


class CargaCar(Modelo):
    """A carga mais recente do SICAR de uma UF."""

    uf: str
    dados_ate: date | None
    """A atualização mais recente de um imóvel no arquivo: até onde vão os dados."""
    publicado_em: date | None
    """A data de publicação no SICAR, se informada na carga."""
    carregado_em: datetime
    """Quando a carga entrou no banco."""


class RedeSolana(Modelo):
    """Onde conferir os registros dos relatórios na Solana."""

    cluster: str
    rpc: str | None
    """Só a origem do RPC (sem caminho nem chave)."""
    programa: str
    """O programa do Solana Attestation Service."""
    autoridade: str | None
    """A identidade pública do NodalTrace na rede: a credencial e o schema derivam dela."""
    credencial: str | None
    schema_: str | None = Field(alias='schema')
    """A PDA do schema NT_RELATORIO (o nome `schema` sombrearia um método do Pydantic)."""


class AncoragemSaude(Modelo):
    """O registro dos relatórios na Solana."""

    ligada: bool
    """O attestor está configurado: os relatórios novos vão para a rede. Desligada, ficam pendentes."""
    serie: str
    """A série dos relatórios deste banco: os números são sequenciais dentro dela."""
    pendentes: int
    """Relatórios ainda não confirmados na rede (pendentes ou em envio)."""
    falhas: int
    """Relatórios que a rede recusou e precisam de revisão."""
    rede: RedeSolana


class Saude(Modelo):
    """GET /saude: a API no ar, as cargas do CAR por UF e o registro dos relatórios na Solana."""

    status: Literal['ok']
    cargas_car: list[CargaCar]
    versao_tiles: str
    """Muda quando os tiles mudam (carga ou migração): vai no endereço deles, para o cache."""
    ancoragem: AncoragemSaude
