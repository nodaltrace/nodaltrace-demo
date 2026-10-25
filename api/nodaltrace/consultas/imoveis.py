"""Imóveis do CAR. A versão que vale de um imóvel é a vigente ou, se ele saiu da carga mais recente do SICAR, a última.
A ficha dela já vem calculada da carga em ref.car_resumo (uma linha por código); as versões e a geometria ficam em
ref.car_imovel (uma linha por versão), sempre na ordem `valido_ate IS NULL DESC, valido_de DESC`."""

from __future__ import annotations

from psycopg import Connection

from ..dominio.conformidade import biomas_em_ingles


def versoes(con: Connection, cod: str) -> list[dict]:
    """Todas as versões do imóvel, a que vale primeiro."""
    return con.execute(
        """SELECT c.cod_imovel, c.uf, c.cod_ibge, coalesce(m.nome, c.municipio) AS municipio, c.area_ha, c.mod_fiscal,
                  c.status AS situacao, c.tipo, c.condicao, c.criado_sicar, c.atualizado_sicar, c.valido_de, c.valido_ate,
                  c.valido_ate IS NULL AS vigente, c.carga_id,
                  ARRAY[ST_XMin(c.geom), ST_YMin(c.geom), ST_XMax(c.geom), ST_YMax(c.geom)] AS limites
           FROM ref.car_imovel c LEFT JOIN ref.municipio m ON m.cod_ibge = c.cod_ibge
           WHERE c.cod_imovel = %s ORDER BY c.valido_ate IS NULL DESC, c.valido_de DESC""",
        (cod,),
    ).fetchall()


def que_valem(con: Connection, cods: list[str]) -> dict[str, dict]:
    """A versão que vale de cada imóvel, por código, com o hash da linha. Códigos inexistentes ficam de fora."""
    linhas = con.execute(
        """SELECT r.cod_imovel, r.uf, r.cod_ibge, coalesce(m.nome, r.municipio) AS municipio, r.area_ha, r.mod_fiscal, r.situacao,
                  r.tipo, r.condicao, r.atualizado_sicar, r.valido_de, r.vigente, encode(r.hash, 'hex') AS hash, r.limites,
                  CASE WHEN r.vigente THEN r.versao_id END AS feicao, ARRAY[ST_X(r.centro), ST_Y(r.centro)] AS centro
           FROM ref.car_resumo r LEFT JOIN ref.municipio m ON m.cod_ibge = r.cod_ibge
           WHERE r.cod_imovel = ANY(%s)""",
        (cods,),
    ).fetchall()
    return {r['cod_imovel']: r for r in linhas}


def cod_da_feicao(con: Connection, feicao: int) -> str | None:
    """O código do imóvel de uma feição dos tiles do CAR (o id da versão vigente); None se o id não é de uma vigente."""
    r = con.execute('SELECT cod_imovel FROM ref.car_resumo WHERE versao_id = %s AND vigente', (feicao,)).fetchone()
    return r['cod_imovel'] if r else None


def biomas(con: Connection, cods: list[str]) -> dict[str, list[dict] | None]:
    """Biomas do IBGE que a versão que vale de cada imóvel atinge, com área e fração (ref.biomas_da_geom, calculado na
    carga); None se os biomas não foram carregados. O nome sai em inglês (NOME_BIOMA): é como a API serve os biomas."""
    linhas = con.execute('SELECT cod_imovel, biomas FROM ref.car_resumo WHERE cod_imovel = ANY(%s)', (cods,)).fetchall()
    return {r['cod_imovel']: biomas_em_ingles(r['biomas']) for r in linhas}


def recorte(con: Connection, cod: str) -> dict | None:
    """Retângulo e contorno simplificado da versão que vale, para as imagens históricas; None se o imóvel não existe."""
    return con.execute(
        """SELECT ST_XMin(geom) AS oeste, ST_YMin(geom) AS sul, ST_XMax(geom) AS leste, ST_YMax(geom) AS norte,
                  ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.00001), 6)::json AS contorno
           FROM ref.car_imovel WHERE cod_imovel = %s ORDER BY valido_ate IS NULL DESC, valido_de DESC LIMIT 1""",
        (cod,),
    ).fetchone()
