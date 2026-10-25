"""Alertas do MapBiomas que atingem os imóveis do CAR (ref.car_alerta, calculado na carga), sempre na camada vigente."""

from __future__ import annotations

from psycopg import Connection

from ..dominio.conformidade import CORTE_EUDR


def dos_imoveis(con: Connection, cods: list[str]) -> dict[str, list[dict]]:
    """Os alertas de cada imóvel, do mais recente para o mais antigo, com a área no imóvel, a área do alerta inteiro e o
    retângulo da interseção. Imóvel sem alerta fica com lista vazia."""
    linhas = con.execute(
        """SELECT c.cod_imovel, c.alerta, c.area_ha, c.detectado_em, c.fontes, c.classe, c.detectado_em > %(corte)s AS pos_corte,
                  (f.atributos->>'area_ha')::float8 AS area_alerta_ha,
                  ARRAY[ST_XMin(c.geom), ST_YMin(c.geom), ST_XMax(c.geom), ST_YMax(c.geom)] AS limites
           FROM ref.car_alerta c
           LEFT JOIN ref.feicao_ambiental f ON f.camada_id = c.camada_id AND f.externo_id = c.alerta
           WHERE c.camada_id = ref.camada_vigente('mapbiomas') AND c.cod_imovel = ANY(%(cods)s)
           ORDER BY c.detectado_em DESC, c.area_ha DESC""",
        {'cods': cods, 'corte': CORTE_EUDR},
    ).fetchall()
    out: dict[str, list[dict]] = {c: [] for c in cods}
    for r in linhas:
        out[r.pop('cod_imovel')].append(r)
    return out


def para_imagens(con: Connection, cod: str) -> list[dict]:
    """Os alertas do imóvel do mais antigo para o mais recente, com a geometria da interseção (simplificada) e um ponto
    do alerta inteiro (para a reserva do MapBiomas em servicos/imagens.py)."""
    return con.execute(
        """SELECT c.alerta, c.detectado_em, ST_AsGeoJSON(ST_SimplifyPreserveTopology(c.geom, 0.00001), 6)::json AS geom,
                  ST_X(p.p) AS lon, ST_Y(p.p) AS lat
           FROM ref.car_alerta c
           LEFT JOIN LATERAL (SELECT ST_PointOnSurface(f.geom) AS p FROM ref.feicao_ambiental f
                              WHERE f.camada_id = c.camada_id AND f.externo_id = c.alerta LIMIT 1) p ON true
           WHERE c.camada_id = ref.camada_vigente('mapbiomas') AND c.cod_imovel = %s
           ORDER BY c.detectado_em, c.area_ha DESC""",
        (cod,),
    ).fetchall()
