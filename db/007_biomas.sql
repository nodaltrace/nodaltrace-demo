-- Biomas do IBGE: camada do mapa e informação de compliance (ainda sem efeito no status).

-- Biomas e Sistema Costeiro-Marinho do Brasil, 1:250.000 (IBGE). Só os seis biomas terrestres.
CREATE TABLE ref.bioma_carga (
  id serial PRIMARY KEY,
  arquivo text NOT NULL,
  hash text NOT NULL,
  edicao text NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ref.bioma (
  cod smallint PRIMARY KEY,
  nome text NOT NULL,
  carga_id int NOT NULL REFERENCES ref.bioma_carga,
  geom geometry(MultiPolygon, 4326) NOT NULL
);

-- Partes subdivididas dos biomas: interseção rápida com imóveis (nível 2, desenho original) e tiles por faixa
-- de zoom (nível 0 simplificado em ~5 km, nível 1 em ~600 m, nível 2 original).
CREATE TABLE ref.bioma_parte (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cod smallint NOT NULL REFERENCES ref.bioma ON DELETE CASCADE,
  nivel smallint NOT NULL,
  geom geometry(Polygon, 4326) NOT NULL,
  geom_3857 geometry(Polygon, 3857) NOT NULL
);
CREATE INDEX bioma_parte_geom ON ref.bioma_parte USING gist (geom) WHERE nivel = 2;
CREATE INDEX bioma_parte_geom_3857 ON ref.bioma_parte USING gist (geom_3857);
CREATE INDEX bioma_parte_nivel ON ref.bioma_parte (nivel);

-- Limites dos biomas (e o litoral) como linhas, por nível: o contorno dos tiles sem as emendas das partes.
CREATE TABLE ref.bioma_limite (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nivel smallint NOT NULL,
  geom_3857 geometry(LineString, 3857) NOT NULL
);
CREATE INDEX bioma_limite_geom_3857 ON ref.bioma_limite USING gist (geom_3857);

-- Biomas que uma geometria atinge, com área e fração: [{cod, nome, area_ha, fracao}], do maior para o menor.
-- Nulo se os biomas não foram carregados.
CREATE OR REPLACE FUNCTION ref.biomas_da_geom(g geometry) RETURNS jsonb STABLE PARALLEL SAFE LANGUAGE sql AS $$
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ref.bioma) THEN NULL ELSE coalesce((
    SELECT jsonb_agg(jsonb_build_object('cod', cod, 'nome', nome, 'area_ha', area_ha,
                                        'fracao', area_ha / nullif(total_ha, 0)) ORDER BY area_ha DESC)
    FROM (
      SELECT b.cod, b.nome, sum(ST_Area(ST_Intersection(p.geom, g)::geography)) / 1e4 AS area_ha,
             ST_Area(g::geography) / 1e4 AS total_ha
      FROM ref.bioma_parte p JOIN ref.bioma b USING (cod)
      WHERE p.nivel = 2 AND p.geom && g AND ST_Intersects(p.geom, g)
      GROUP BY b.cod, b.nome
    ) x WHERE area_ha > 0
  ), '[]'::jsonb) END
$$;

-- Tiles dos biomas: preenchimento ('bioma') e limites ('bioma_limite') no mesmo tile.
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
  SELECT (SELECT coalesce(ST_AsMVT(f, 'bioma', 4096, 'geom'), '') FROM f WHERE geom IS NOT NULL)
      || (SELECT coalesce(ST_AsMVT(l, 'bioma_limite', 4096, 'geom'), '') FROM l WHERE geom IS NOT NULL)
$$;
