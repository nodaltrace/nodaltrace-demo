-- Tiles do CAR com o id da versão como id da feição, sem o código do imóvel: o código (43 caracteres) era quase metade
-- do tile (num tile do RS no zoom 10, 104 de 210 KB). O mapa destaca os imóveis pelo id (feature-state do MapLibre, sem
-- refazer os tiles a cada clique) e pede o código à API só no clique (GET /car/feicao/{id}). O id é o ref.car_imovel.id
-- da versão vigente, o mesmo de ref.car_resumo.versao_id; muda quando o imóvel ganha versão nova, junto com a
-- versao_tiles de GET /saude.

CREATE OR REPLACE FUNCTION ref.car_tiles(z int, x int, y int) RETURNS bytea STABLE PARALLEL SAFE LANGUAGE sql AS $$
  WITH env AS (SELECT ST_TileEnvelope(z, x, y) AS e),
  f AS (
    SELECT c.id, c.status,
           ST_AsMVTGeom(
             CASE WHEN z < 14 THEN ST_Simplify(c.geom_3857, ref.meio_pixel(z), true) ELSE c.geom_3857 END,
             env.e, 4096, 16) AS geom
    FROM ref.car_imovel c, env
    WHERE z >= 10 AND c.valido_ate IS NULL AND c.geom_3857 && env.e
    -- No zoom 10 um tile cobre uns 1.500 km²; imóveis menores que ~1 pixel não aparecem.
      AND (z >= 12 OR c.area_ha >= 4 ^ (12 - z))
  )
  SELECT ST_AsMVT(f, 'car', 4096, 'geom', 'id') FROM f
$$;
