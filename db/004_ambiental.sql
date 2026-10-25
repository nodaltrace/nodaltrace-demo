-- Camada ambiental real: MapBiomas Alerta (alertas e cruzamento com o CAR).

-- Cada carga de uma camada guarda de que arquivo veio e o hash dele: recarregar o mesmo arquivo não duplica.
ALTER TABLE ref.camada
  ADD COLUMN arquivo text,
  ADD COLUMN hash text,
  ADD COLUMN data_referencia date,
  ADD COLUMN feicoes int;

-- Identificador da feição no provedor (o código do alerta, no MapBiomas) e geometria para os tiles.
ALTER TABLE ref.feicao_ambiental
  ADD COLUMN externo_id text,
  ADD COLUMN geom_3857 geometry(MultiPolygon, 3857);
CREATE INDEX feicao_ambiental_externo ON ref.feicao_ambiental (camada_id, externo_id);
CREATE INDEX feicao_ambiental_geom_3857 ON ref.feicao_ambiental USING gist (geom_3857);

-- Cruzamento alerta × imóvel: a parte de cada alerta dentro de cada imóvel do CAR carregado (ref.cruzar_car_alerta, 024).
CREATE TABLE ref.car_alerta (
  camada_id int NOT NULL REFERENCES ref.camada ON DELETE CASCADE,
  cod_imovel text NOT NULL,
  alerta text NOT NULL,
  area_ha double precision NOT NULL,
  detectado_em date NOT NULL,
  fontes text[] NOT NULL,
  classe text,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  geom_3857 geometry(MultiPolygon, 3857) NOT NULL,
  PRIMARY KEY (camada_id, cod_imovel, alerta)
);
CREATE INDEX car_alerta_imovel ON ref.car_alerta (cod_imovel, camada_id);
CREATE INDEX car_alerta_geom_3857 ON ref.car_alerta USING gist (geom_3857);

-- Camada vigente de um tipo: a carregada por último.
CREATE OR REPLACE FUNCTION ref.camada_vigente(t text) RETURNS int STABLE PARALLEL SAFE LANGUAGE sql AS
$$ SELECT id FROM ref.camada WHERE tipo = t ORDER BY carregado_em DESC, id DESC LIMIT 1 $$;

-- Alertas do MapBiomas: com o mapa afastado só os maiores, para o tile não pesar.
-- pos_corte: detectado depois da data de corte da EUDR (31/12/2020).
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
      AND (z >= 10 OR (a.atributos->>'area_ha')::float8 >= 2 ^ (10 - z))
  )
  SELECT ST_AsMVT(f, 'alerta', 4096, 'geom') FROM f WHERE geom IS NOT NULL
$$;

-- Parte de cada alerta que cai dentro de um imóvel do CAR.
CREATE OR REPLACE FUNCTION ref.car_alerta_tiles(z int, x int, y int) RETURNS bytea STABLE PARALLEL SAFE LANGUAGE sql AS $$
  WITH env AS (SELECT ST_TileEnvelope(z, x, y) AS e),
  f AS (
    SELECT c.cod_imovel AS cod, c.alerta, c.area_ha::float8 AS area_ha, c.detectado_em > date '2020-12-31' AS pos_corte,
           ST_AsMVTGeom(c.geom_3857, env.e, 4096, 16) AS geom
    FROM ref.car_alerta c, env
    WHERE z >= 10 AND c.camada_id = ref.camada_vigente('mapbiomas') AND c.geom_3857 && env.e
  )
  SELECT ST_AsMVT(f, 'car_alerta', 4096, 'geom') FROM f WHERE geom IS NOT NULL
$$;
