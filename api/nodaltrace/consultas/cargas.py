"""As bases carregadas pela pipeline: cargas do CAR por UF, camadas ambientais (MapBiomas, embargos) e biomas do IBGE."""

from __future__ import annotations

import hashlib

from psycopg import Connection


# As três datas de uma base (db/028_datas_das_bases.sql): `dados_ate`, até onde vão os dados (tirada deles);
# `publicado_em`, a publicação na fonte, se informada na carga; `carregado_em`, quando entrou no banco.

def car(con: Connection) -> list[dict]:
    """A carga mais recente do SICAR de cada UF."""
    return con.execute(
        'SELECT DISTINCT ON (uf) uf, dados_ate, publicado_em, carregado_em FROM ref.car_carga ORDER BY uf, id DESC'
    ).fetchall()


def camada_vigente(con: Connection, tipo: str) -> dict | None:
    """A camada vigente do tipo (`mapbiomas`, `embargo`); None se nunca foi carregada."""
    return con.execute(
        """SELECT id, nome, fonte, versao, dados_ate, publicado_em, carregado_em
           FROM ref.camada WHERE id = ref.camada_vigente(%s)""",
        (tipo,),
    ).fetchone()


def camadas(con: Connection) -> list[dict]:
    """Todas as camadas ambientais carregadas, da mais recente para a mais antiga de cada tipo."""
    return con.execute(
        """SELECT c.id, c.tipo, c.nome, c.fonte, c.versao, c.dados_ate, c.publicado_em, c.carregado_em,
                  coalesce(c.feicoes, (SELECT count(*) FROM ref.feicao_ambiental f WHERE f.camada_id = c.id)) AS feicoes
           FROM ref.camada c ORDER BY c.tipo, c.carregado_em DESC"""
    ).fetchall()


def bioma(con: Connection) -> dict | None:
    """A carga dos biomas do IBGE em uso; None se os biomas não foram carregados."""
    return con.execute(
        'SELECT edicao, carregado_em FROM ref.bioma_carga c WHERE EXISTS (SELECT 1 FROM ref.bioma b WHERE b.carga_id = c.id)'
    ).fetchone()


def versao_tiles(con: Connection) -> str:
    """Muda quando uma carga (CAR, MapBiomas, biomas) ou uma migração muda o que os tiles mostram. O frontend a põe no
    endereço dos tiles, que assim podem ficar em cache como imutáveis (deploy/nginx.conf). Na demo do hackathon, o
    total de registros do CAR também entra: um banco reduzido de novo (deploy/demo/reduzir.sh) tem as mesmas cargas com
    outros imóveis."""
    bases = con.execute(
        """SELECT concat_ws('|', (SELECT max(id) FROM ref.car_carga), ref.camada_vigente('mapbiomas'),
                            (SELECT max(carga_id) FROM ref.bioma), (SELECT max(nome) FROM public.migracao),
                            (SELECT sum(registros) FROM ref.car_carga)) AS v"""
    ).fetchone()['v']
    return hashlib.sha256(bases.encode()).hexdigest()[:12]
