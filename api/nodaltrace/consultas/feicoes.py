"""Cruzamento dos imóveis do CAR com as feições de uma camada ambiental genérica (embargos)."""

from __future__ import annotations

from datetime import date

from psycopg import Connection


def intersecoes(con: Connection, tipo: str, cods: list[str], depois_de: date | None = None) -> dict[str, dict]:
    """Por imóvel (versão vigente), quantas feições da camada vigente do tipo o atingem e a área somada da interseção.
    `depois_de`: só as feições com evento depois desta data (ou sem data). Imóvel sem interseção fica de fora."""
    linhas = con.execute(
        """SELECT c.cod_imovel, count(*) AS n, sum(ST_Area(ST_Intersection(f.geom, c.geom)::geography)) / 1e4 AS area_ha
           FROM ref.car_imovel c
           JOIN ref.feicao_ambiental f ON f.camada_id = ref.camada_vigente(%(tipo)s) AND f.geom && c.geom AND ST_Intersects(f.geom, c.geom)
           WHERE c.cod_imovel = ANY(%(cods)s) AND c.valido_ate IS NULL
             AND (%(depois)s::date IS NULL OR f.data_evento IS NULL OR f.data_evento > %(depois)s::date)
           GROUP BY c.cod_imovel""",
        {'tipo': tipo, 'cods': cods, 'depois': depois_de},
    ).fetchall()
    return {r['cod_imovel']: r for r in linhas}
