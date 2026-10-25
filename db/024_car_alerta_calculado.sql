-- Cruzamento alerta × imóvel calculado sobre o CAR carregado, no lugar do que o MapBiomas publica: os alertas de uma
-- camada contra a última versão de cada imóvel da UF (a vigente ou, se o imóvel saiu da carga, a última). Com `p_carga`,
-- só os imóveis que ganharam versão nessa carga do CAR. A interseção é a de ref.alertas_da_geom; como no cruzamento do
-- MapBiomas, sem área mínima. Refaz os pares do alvo e devolve quantos gravou; sem camada, não faz nada.
CREATE OR REPLACE FUNCTION ref.cruzar_car_alerta(p_camada int, p_uf char(2), p_carga int DEFAULT NULL)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  n int;
BEGIN
  IF p_camada IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM ref.car_alerta a
  WHERE a.camada_id = p_camada
    AND a.cod_imovel IN (SELECT cod_imovel FROM ref.car_imovel WHERE uf = p_uf AND (p_carga IS NULL OR carga_id = p_carga));

  INSERT INTO ref.car_alerta (camada_id, cod_imovel, alerta, area_ha, detectado_em, fontes, classe, geom, geom_3857)
  SELECT p_camada, i.cod_imovel, f.externo_id, ST_Area(x.g::geography) / 1e4, f.data_evento,
         ARRAY(SELECT jsonb_array_elements_text(coalesce(f.atributos->'fontes', '[]'::jsonb))), f.atributos->>'classe',
         x.g, ST_Transform(x.g, 3857)
  -- Só os alertas dentro da caixa do alvo: com o Brasil inteiro na camada, poupa uma busca no índice por alerta.
  FROM (SELECT ST_SetSRID(ST_Extent(geom)::geometry, 4326) AS e
        FROM ref.car_imovel WHERE uf = p_uf AND (p_carga IS NULL OR carga_id = p_carga)) alvo
  JOIN ref.feicao_ambiental f ON f.geom && alvo.e
  JOIN ref.car_imovel i ON i.uf = p_uf AND i.geom && f.geom AND ST_Intersects(i.geom, f.geom)
  CROSS JOIN LATERAL (
    -- OFFSET 0: a interseção é calculada uma vez por par, não a cada uso de x.g.
    SELECT ST_Multi(ST_CollectionExtract(ST_Intersection(ST_MakeValid(f.geom), ST_MakeValid(i.geom)), 3))::geometry(MultiPolygon, 4326) AS g
    OFFSET 0
  ) x
  WHERE f.camada_id = p_camada AND f.data_evento IS NOT NULL
    AND (p_carga IS NULL OR i.carga_id = p_carga)
    -- Última versão do imóvel: a vigente ou, entre as fechadas, a que nenhuma outra sucedeu.
    AND (i.valido_ate IS NULL OR NOT EXISTS (
      SELECT 1 FROM ref.car_imovel v
      WHERE v.uf = i.uf AND v.cod_imovel = i.cod_imovel AND (v.valido_de, v.id) > (i.valido_de, i.id)))
    AND NOT ST_IsEmpty(x.g) AND ST_Area(x.g) > 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
