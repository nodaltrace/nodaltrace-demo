-- Propriedades desenhadas: de que imóveis do CAR a área de origem é feita, que alertas a atingem e onde fica.
-- Só funções do `ref` (aplicadas uma vez); as tabelas das operações vêm na 021.

-- A UF e o município de uma geometria: a malha municipal passa a ser consultada pela geometria em graus.
CREATE INDEX IF NOT EXISTS municipio_geom ON ref.municipio USING gist (geom);

-- Fatia descartável como ruído de desenho: abaixo de min_ha, ou pequena em fração e em área ao mesmo tempo.
CREATE OR REPLACE FUNCTION ref.ruido(area_ha float8, fracao float8, min_ha float8, min_frac float8, cap_ha float8)
RETURNS boolean IMMUTABLE PARALLEL SAFE LANGUAGE sql AS $$
  SELECT area_ha < min_ha OR (fracao < min_frac AND area_ha < cap_ha)
$$;

-- Polígonos válidos da geometria, com os vértices na grade de 1e-7° (~1 cm): bordas quase coincidentes de imóveis
-- vizinhos passam a coincidir, e a decomposição em faces não gera lascas. O CAR não é validado na carga.
CREATE OR REPLACE FUNCTION ref.poligonos_limpos(g geometry) RETURNS geometry IMMUTABLE PARALLEL SAFE LANGUAGE sql AS $$
  SELECT nullif(ST_CollectionExtract(ST_MakeValid(ST_ReducePrecision(ST_CollectionExtract(ST_MakeValid(ST_Force2D(g)), 3), 1e-7)), 3),
                'GEOMETRYCOLLECTION EMPTY'::geometry)
$$;

-- Unidades de origem de uma área: a parte dela em cada imóvel vigente do CAR e a sobra fora de qualquer imóvel.
-- Onde imóveis se sobrepõem, a área sobreposta se divide igualmente entre eles; as frações somam 1. A geometria de
-- cada unidade (para cruzar alertas) é a área que ela cobre, inteira mesmo onde é dividida. Fatias de ruído saem e a
-- área delas se redistribui na proporção das demais; se nada passar do ruído, fica a maior.
CREATE OR REPLACE FUNCTION ref.unidades_da_geom(g geometry, min_ha float8 DEFAULT 0.5, min_frac float8 DEFAULT 0.01, cap_ha float8 DEFAULT 2)
RETURNS TABLE (tipo text, cod_imovel text, uf char(2), status char(2), hash text, area_car_ha float8, area_ha float8, fracao float8, geom geometry)
STABLE LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  p geometry := ref.poligonos_limpos(g);
  total float8;
  -- Imóveis que a área toca, recortados por ela (vetores paralelos).
  cods text[]; ufs char(2)[]; sts char(2)[]; hashes text[]; areas_car float8[]; gs geometry[];
  -- Partes: imóvel (nulo = sobra), área atribuída e geometria coberta.
  p_cod text[]; p_area float8[]; p_g geometry[];
  sobra geometry;
BEGIN
  IF p IS NULL THEN
    RETURN;
  END IF;
  total := ST_Area(p::geography) / 1e4;
  IF total = 0 THEN
    RETURN;
  END IF;

  SELECT array_agg(c.cod_imovel ORDER BY c.cod_imovel), array_agg(c.uf ORDER BY c.cod_imovel), array_agg(c.status ORDER BY c.cod_imovel),
         array_agg(encode(c.hash, 'hex') ORDER BY c.cod_imovel), array_agg(c.area_ha ORDER BY c.cod_imovel), array_agg(x.g ORDER BY c.cod_imovel)
  INTO cods, ufs, sts, hashes, areas_car, gs
  FROM ref.car_imovel c, LATERAL (SELECT ref.poligonos_limpos(ST_Intersection(ref.poligonos_limpos(c.geom), p)) AS g) x
  WHERE c.valido_ate IS NULL AND c.geom && p AND ST_Intersects(c.geom, p) AND x.g IS NOT NULL;

  IF cods IS NULL THEN
    p_cod := ARRAY[NULL]::text[]; p_area := ARRAY[total]; p_g := ARRAY[p];
  -- Sobreposição de verdade: interiores que se cruzam em área (bordas comuns não contam).
  ELSIF NOT EXISTS (
    SELECT 1 FROM unnest(gs) WITH ORDINALITY a(g, i) JOIN unnest(gs) WITH ORDINALITY b(g, i) ON a.i < b.i AND a.g && b.g
    WHERE ST_Relate(a.g, b.g, '2********')
  ) THEN
    -- Caso comum: cada imóvel recortado pela área; a sobra é o que nenhum cobre.
    SELECT array_agg(c), array_agg(ST_Area(x::geography) / 1e4), array_agg(x) INTO p_cod, p_area, p_g FROM unnest(cods, gs) u(c, x);
    SELECT ref.poligonos_limpos(ST_Difference(p, ST_Union(x))) INTO sobra FROM unnest(gs) u(x);
    IF sobra IS NOT NULL THEN
      p_cod := p_cod || NULL::text; p_area := p_area || (ST_Area(sobra::geography) / 1e4); p_g := p_g || sobra;
    END IF;
  ELSE
    -- Faces do cruzamento dos contornos: cada face sabe que imóveis a cobrem e reparte a área igualmente entre eles.
    WITH linhas AS (
      SELECT ST_Union(ST_Boundary(x)) AS l FROM (SELECT unnest(gs) AS x UNION ALL SELECT p) s
    ), faces AS (
      SELECT (ST_Dump(pg)).geom AS f FROM (SELECT ST_Polygonize(l) AS pg FROM linhas) s
    ), dentro AS (
      SELECT row_number() OVER () AS id, f, ST_PointOnSurface(f) AS pt, ST_Area(f::geography) / 1e4 AS a
      FROM faces WHERE ST_Intersects(ST_PointOnSurface(f), p)
    ), cobre AS (
      SELECT d.id, d.f, d.a, u.c, count(u.c) OVER (PARTITION BY d.id) AS n
      FROM dentro d LEFT JOIN unnest(cods, gs) u(c, x) ON u.x && d.pt AND ST_Intersects(d.pt, u.x)
    ), partes AS (
      SELECT c, sum(a / greatest(n, 1)) AS a, ST_Union(f) AS g FROM cobre GROUP BY c
    )
    SELECT array_agg(c), array_agg(a), array_agg(g) INTO p_cod, p_area, p_g FROM partes;
  END IF;

  RETURN QUERY
  WITH partes AS (
    SELECT u.c, u.a, u.g, u.a / total AS fr FROM unnest(p_cod, p_area, p_g) u(c, a, g) WHERE u.a > 0
  ), ficam AS (
    SELECT * FROM partes WHERE NOT ref.ruido(partes.a, partes.fr, min_ha, min_frac, cap_ha)
    UNION ALL
    SELECT * FROM (SELECT * FROM partes ORDER BY partes.a DESC LIMIT 1) maior
    WHERE NOT EXISTS (SELECT 1 FROM partes WHERE NOT ref.ruido(partes.a, partes.fr, min_ha, min_frac, cap_ha))
  ), soma AS (SELECT sum(ficam.a) AS s FROM ficam)
  SELECT CASE WHEN f.c IS NULL THEN 'area_propria' ELSE 'car' END, f.c, c.uf, c.st, c.h, c.ac, f.a, f.a / soma.s, f.g
  FROM ficam f CROSS JOIN soma
  LEFT JOIN unnest(cods, ufs, sts, hashes, areas_car) c(cod, uf, st, h, ac) ON c.cod = f.c
  ORDER BY f.c IS NULL, f.a DESC;
END
$$;

-- Alertas do MapBiomas (camada vigente) que atingem uma geometria, no formato de ref.car_alerta, com a área da
-- interseção com a geometria (não com o imóvel inteiro).
CREATE OR REPLACE FUNCTION ref.alertas_da_geom(g geometry)
RETURNS TABLE (alerta text, area_ha float8, detectado_em date, fontes text[], classe text, area_alerta_ha float8,
               oeste float8, sul float8, leste float8, norte float8)
STABLE PARALLEL SAFE LANGUAGE sql AS $$
  SELECT f.externo_id, ST_Area(x.i::geography) / 1e4, f.data_evento,
         ARRAY(SELECT jsonb_array_elements_text(coalesce(f.atributos->'fontes', '[]'::jsonb))), f.atributos->>'classe',
         (f.atributos->>'area_ha')::float8, ST_XMin(x.i), ST_YMin(x.i), ST_XMax(x.i), ST_YMax(x.i)
  FROM ref.feicao_ambiental f, LATERAL (SELECT ST_Intersection(ST_MakeValid(f.geom), g) AS i) x
  WHERE f.camada_id = ref.camada_vigente('mapbiomas') AND f.geom && g AND ST_Intersects(f.geom, g)
    AND f.data_evento IS NOT NULL AND NOT ST_IsEmpty(x.i) AND ST_Area(x.i) > 0
  ORDER BY f.data_evento DESC, 2 DESC
$$;

-- Onde fica uma geometria: {pais, uf, cod_ibge, municipio, area_ha, area_br_ha}. É Brasil quando a parte dentro do
-- território (mapa de biomas do IBGE, que cobre todo o território terrestre; sem ele, a malha municipal) passa do
-- ruído; sem nenhuma das duas bases, assume Brasil. Fora do Brasil, `pais` é nulo: quem chama usa o informado.
-- UF e município: o da maior interseção na malha municipal carregada (nulos se a UF não estiver carregada).
CREATE OR REPLACE FUNCTION ref.local_da_geom(g geometry, min_ha float8 DEFAULT 0.5, min_frac float8 DEFAULT 0.01, cap_ha float8 DEFAULT 2)
RETURNS jsonb STABLE PARALLEL SAFE LANGUAGE sql AS $$
  WITH p AS (SELECT ref.poligonos_limpos(g) AS g),
  t AS (SELECT p.g, ST_Area(p.g::geography) / 1e4 AS total FROM p),
  mun AS (
    SELECT m.cod_ibge, m.nome, m.uf, ST_Area(ST_Intersection(ST_MakeValid(m.geom), t.g)::geography) / 1e4 AS a
    FROM t JOIN ref.municipio m ON m.geom && t.g AND ST_Intersects(m.geom, t.g)
  ),
  br AS (
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM ref.bioma) THEN (
        SELECT coalesce(sum(ST_Area(ST_Intersection(b.geom, t.g)::geography)) / 1e4, 0)
        FROM t JOIN ref.bioma_parte b ON b.nivel = 2 AND b.geom && t.g AND ST_Intersects(b.geom, t.g))
      WHEN EXISTS (SELECT 1 FROM ref.municipio) THEN (SELECT coalesce(sum(a), 0) FROM mun)
      ELSE (SELECT total FROM t)
    END AS a
  )
  SELECT jsonb_build_object(
    'pais', CASE WHEN t.total > 0 AND NOT ref.ruido(br.a, br.a / t.total, min_ha, min_frac, cap_ha) THEN 'BR' END,
    'area_ha', t.total, 'area_br_ha', br.a,
    'uf', m.uf, 'cod_ibge', m.cod_ibge, 'municipio', m.nome)
  FROM t CROSS JOIN br LEFT JOIN LATERAL (SELECT * FROM mun ORDER BY a DESC LIMIT 1) m ON true
$$;
