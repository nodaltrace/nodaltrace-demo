-- Polígonos de todos os alertas do recorte, sem filtro de área.
-- O mapa só os exibe a partir do zoom escolhido (7 ou mais).
CREATE OR REPLACE FUNCTION ref.alerta_tiles(z int, x int, y int) RETURNS bytea STABLE PARALLEL SAFE LANGUAGE sql AS $$
  WITH env AS (SELECT ST_TileEnvelope(z, x, y) AS e),
  f AS (
    SELECT a.externo_id AS alerta, (a.atributos->>'area_ha')::float8 AS area_ha, extract(year FROM a.data_evento)::int AS ano,
           a.data_evento > date '2020-12-31' AS pos_corte, a.atributos->>'classe' AS classe,
           ST_AsMVTGeom(
             CASE WHEN z < 13 THEN ST_SimplifyPreserveTopology(a.geom_3857, ref.meio_pixel(z)) ELSE a.geom_3857 END,
             env.e, 4096, 16) AS geom
    FROM ref.feicao_ambiental a, env
    WHERE a.camada_id = ref.camada_vigente('mapbiomas') AND a.geom_3857 && env.e
  )
  SELECT ST_AsMVT(f, 'alerta', 4096, 'geom') FROM f WHERE geom IS NOT NULL
$$;
