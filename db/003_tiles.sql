-- Funções de vector tiles servidas pelo Martin. O navegador só baixa o recorte visível:
-- polígonos de imóveis a partir do zoom 10.

-- Tolerância de simplificação: meio pixel do tile no zoom pedido.
CREATE OR REPLACE FUNCTION ref.meio_pixel(z int) RETURNS float8 IMMUTABLE PARALLEL SAFE LANGUAGE sql AS
$$ SELECT 40075016.68557849 / (4096 * 2 ^ z) * 0.5 $$;

CREATE OR REPLACE FUNCTION ref.car_tiles(z int, x int, y int) RETURNS bytea STABLE PARALLEL SAFE LANGUAGE sql AS $$
  WITH env AS (SELECT ST_TileEnvelope(z, x, y) AS e),
  f AS (
    SELECT c.cod_imovel AS cod, c.status, c.tipo, round(c.area_ha)::int AS area_ha,
           ST_AsMVTGeom(
             CASE WHEN z < 14 THEN ST_SimplifyPreserveTopology(c.geom_3857, ref.meio_pixel(z)) ELSE c.geom_3857 END,
             env.e, 4096, 16) AS geom
    FROM ref.car_imovel c, env
    WHERE z >= 10 AND c.valido_ate IS NULL AND c.geom_3857 && env.e
    -- No zoom 10 um tile cobre uns 1.500 km²; imóveis menores que ~1 pixel não aparecem.
      AND (z >= 12 OR c.area_ha >= 4 ^ (12 - z))
  )
  SELECT ST_AsMVT(f, 'car', 4096, 'geom') FROM f WHERE geom IS NOT NULL
$$;
