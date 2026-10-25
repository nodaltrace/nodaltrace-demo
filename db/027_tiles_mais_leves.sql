-- Tiles mais leves e mais rápidos, com o mesmo desenho no mapa.
--
-- - Cada geometria é simplificada uma vez só: o filtro `WHERE geom IS NOT NULL` de fora era empurrado para dentro do
--   scan e repetia a simplificação e o ST_AsMVTGeom de cada linha (o ST_AsMVT já ignora geometria nula).
-- - ST_Simplify(…, true) no lugar do ST_SimplifyPreserveTopology: o mesmo resultado no tile (o ST_AsMVTGeom já devolve
--   polígonos válidos) com uma fração do custo nos polígonos grandes.
-- - A camada vigente do MapBiomas é lida uma vez por tile (subconsulta), não uma vez por linha.
-- - Só os atributos que o mapa usa: car (cod, status), alerta (pos_corte), car_alerta (cod, pos_corte).
-- - Alertas abaixo do zoom 10: o que tem menos área que um pixel de tela vira um ponto (um por pixel e por pos_corte),
--   e os pontos de mesmo pos_corte saem juntos num MultiPoint, ordenados, que o MVT grava em poucos bytes por ponto; o
--   mapa os desenha como bolinhas da mesma cor. Num tile do zoom 7 na Amazônia, 33 mil dos 34 mil alertas eram menores
--   que um pixel.

CREATE OR REPLACE FUNCTION ref.car_tiles(z int, x int, y int) RETURNS bytea STABLE PARALLEL SAFE LANGUAGE sql AS $$
  WITH env AS (SELECT ST_TileEnvelope(z, x, y) AS e),
  f AS (
    SELECT c.cod_imovel AS cod, c.status,
           ST_AsMVTGeom(
             CASE WHEN z < 14 THEN ST_Simplify(c.geom_3857, ref.meio_pixel(z), true) ELSE c.geom_3857 END,
             env.e, 4096, 16) AS geom
    FROM ref.car_imovel c, env
    WHERE z >= 10 AND c.valido_ate IS NULL AND c.geom_3857 && env.e
    -- No zoom 10 um tile cobre uns 1.500 km²; imóveis menores que ~1 pixel não aparecem.
      AND (z >= 12 OR c.area_ha >= 4 ^ (12 - z))
  )
  SELECT ST_AsMVT(f, 'car', 4096, 'geom') FROM f
$$;

CREATE OR REPLACE FUNCTION ref.alerta_tiles(z int, x int, y int) RETURNS bytea STABLE PARALLEL SAFE LANGUAGE sql AS $$
  WITH env AS (
    SELECT ST_TileEnvelope(z, x, y) AS e, (SELECT ref.camada_vigente('mapbiomas')) AS camada,
           -- Área de um pixel de tela neste zoom, em ha (o MapLibre desenha os tiles vetoriais com 512 px).
           (40075016.68557849 / (512 * 2 ^ z)) ^ 2 / 1e4 AS pixel_ha
  ),
  a AS (
    SELECT a.data_evento > date '2020-12-31' AS pos_corte, a.geom_3857 AS g, env.e,
           z < 10 AND (a.atributos->>'area_ha')::float8 < env.pixel_ha AS ponto
    FROM ref.feicao_ambiental a, env
    WHERE a.camada_id = env.camada AND a.geom_3857 && env.e
  ),
  f AS (
    SELECT pos_corte,
           ST_AsMVTGeom(CASE WHEN z < 13 THEN ST_Simplify(g, ref.meio_pixel(z), true) ELSE g END, e, 4096, 16) AS geom
    FROM a WHERE NOT ponto
    UNION ALL
    SELECT pos_corte, ST_Collect(geom ORDER BY ST_Y(geom), ST_X(geom))
    FROM (SELECT DISTINCT pos_corte, ST_SnapToGrid(ST_AsMVTGeom(ST_PointOnSurface(g), e, 4096, 0), 8) AS geom FROM a WHERE ponto) p
    WHERE geom IS NOT NULL
    GROUP BY pos_corte
  )
  SELECT ST_AsMVT(f, 'alerta', 4096, 'geom') FROM f
$$;

CREATE OR REPLACE FUNCTION ref.car_alerta_tiles(z int, x int, y int) RETURNS bytea STABLE PARALLEL SAFE LANGUAGE sql AS $$
  WITH env AS (SELECT ST_TileEnvelope(z, x, y) AS e, (SELECT ref.camada_vigente('mapbiomas')) AS camada),
  f AS (
    SELECT c.cod_imovel AS cod, c.detectado_em > date '2020-12-31' AS pos_corte,
           ST_AsMVTGeom(
             CASE WHEN z < 14 THEN ST_Simplify(c.geom_3857, ref.meio_pixel(z), true) ELSE c.geom_3857 END,
             env.e, 4096, 16) AS geom
    FROM ref.car_alerta c, env
    WHERE z >= 10 AND c.camada_id = env.camada AND c.geom_3857 && env.e
  )
  SELECT ST_AsMVT(f, 'car_alerta', 4096, 'geom') FROM f
$$;

CREATE OR REPLACE FUNCTION ref.bioma_tiles(z int, x int, y int) RETURNS bytea STABLE PARALLEL SAFE LANGUAGE sql AS $$
  WITH env AS (SELECT ST_TileEnvelope(z, x, y) AS e),
  nivel AS (SELECT CASE WHEN z < 5 THEN 0 WHEN z < 9 THEN 1 ELSE 2 END AS n),
  f AS (
    SELECT p.cod, b.nome, ST_AsMVTGeom(p.geom_3857, env.e, 4096, 16) AS geom
    FROM ref.bioma_parte p JOIN ref.bioma b USING (cod), env, nivel
    WHERE p.nivel = nivel.n AND p.geom_3857 && env.e
  ),
  l AS (
    SELECT ST_AsMVTGeom(b.geom_3857, env.e, 4096, 16) AS geom
    FROM ref.bioma_limite b, env, nivel
    WHERE b.nivel = nivel.n AND b.geom_3857 && env.e
  )
  SELECT (SELECT coalesce(ST_AsMVT(f, 'bioma', 4096, 'geom'), '') FROM f)
      || (SELECT coalesce(ST_AsMVT(l, 'bioma_limite', 4096, 'geom'), '') FROM l)
$$;
