-- Demo do hackathon (só no banco reduzido, nunca no de desenvolvimento): o CAR nos tiles a partir do zoom 8, em vez do
-- 10 de db/030_tiles_car_com_id.sql e db/027_tiles_mais_leves.sql. Com só o RS e um quarto dos imóveis, o tile cabe:
-- no zoom 8, o mais denso (norte do RS) tem ~240 KB. O corte por área desce dois zooms junto: o imóvel aparece quando
-- tem uns 2 pixels (16 ha no zoom 8, 4 no 9, 1 no 10, todos do 11 em diante). Aplicado pelo deploy/demo/reduzir.sh e,
-- no banco do Railway, à mão, sempre com o registro em public.migracao, que muda a versao_tiles.

CREATE OR REPLACE FUNCTION ref.car_tiles(z int, x int, y int) RETURNS bytea STABLE PARALLEL SAFE LANGUAGE sql AS $$
  WITH env AS (SELECT ST_TileEnvelope(z, x, y) AS e),
  f AS (
    SELECT c.id, c.status,
           ST_AsMVTGeom(
             CASE WHEN z < 14 THEN ST_Simplify(c.geom_3857, ref.meio_pixel(z), true) ELSE c.geom_3857 END,
             env.e, 4096, 16) AS geom
    FROM ref.car_imovel c, env
    WHERE z >= 8 AND c.valido_ate IS NULL AND c.geom_3857 && env.e
      AND (z >= 11 OR c.area_ha >= 4 ^ (10 - z))
  )
  SELECT ST_AsMVT(f, 'car', 4096, 'geom', 'id') FROM f
$$;

CREATE OR REPLACE FUNCTION ref.car_alerta_tiles(z int, x int, y int) RETURNS bytea STABLE PARALLEL SAFE LANGUAGE sql AS $$
  WITH env AS (SELECT ST_TileEnvelope(z, x, y) AS e, (SELECT ref.camada_vigente('mapbiomas')) AS camada),
  f AS (
    SELECT c.cod_imovel AS cod, c.detectado_em > date '2020-12-31' AS pos_corte,
           ST_AsMVTGeom(
             CASE WHEN z < 14 THEN ST_Simplify(c.geom_3857, ref.meio_pixel(z), true) ELSE c.geom_3857 END,
             env.e, 4096, 16) AS geom
    FROM ref.car_alerta c, env
    WHERE z >= 8 AND c.camada_id = env.camada AND c.geom_3857 && env.e
  )
  SELECT ST_AsMVT(f, 'car_alerta', 4096, 'geom') FROM f
$$;
