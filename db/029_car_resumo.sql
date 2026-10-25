-- Ficha de cada imóvel do CAR já calculada: uma linha por código, com a versão que vale (a vigente ou, se o imóvel saiu
-- da carga mais recente do SICAR, a última) e o que a API lê dela a toda hora. Antes, cada ficha, lista e relatório
-- refazia a busca da versão que vale entre as versões de todas as partições e recalculava os biomas (0,1 a 0,8 ms por
-- imóvel, só guardados na memória do processo).
--
-- - A pipeline mantém a tabela: a carga do CAR refaz as linhas dos imóveis que mudaram (atualizar_car_resumo), a do
--   MapBiomas o resumo dos alertas (resumir_alertas) e a dos biomas os biomas de todos (resumir_biomas).
-- - O código nunca sai: um imóvel que deixou o SICAR fica com a última versão e vigente = false.
-- - versao_id é o ref.car_imovel.id da versão que vale. Com vigente, é também o id da feição do imóvel nos tiles do CAR.
-- - O nome do município não fica aqui: a API o lê de ref.municipio (carregado depois do CAR, às vezes), com o do SICAR
--   como reserva.
-- - O corte da EUDR de resumir_alertas é o de dominio/conformidade.py (conferido por tests/test_paridade.py).
--
-- Esta migração monta a tabela com o que já está carregado: no RS inteiro, cerca de um minuto e meio.

CREATE TABLE ref.car_resumo (
  cod_imovel text PRIMARY KEY,
  uf char(2) NOT NULL,
  versao_id bigint NOT NULL,
  vigente boolean NOT NULL,
  cod_ibge int,
  municipio text,
  area_ha double precision,
  mod_fiscal double precision,
  situacao char(2),
  tipo text,
  condicao text,
  criado_sicar date,
  atualizado_sicar date,
  valido_de date NOT NULL,
  carga_id int NOT NULL,
  hash bytea NOT NULL,
  -- [oeste, sul, leste, norte] da versão que vale.
  limites double precision[] NOT NULL,
  -- Um ponto dentro do imóvel, para marcá-lo com o mapa afastado.
  centro geometry(Point, 4326) NOT NULL,
  -- ref.biomas_da_geom: [{cod, nome, area_ha, fracao}]; nulo se os biomas não estavam carregados.
  biomas jsonb,
  -- Alertas da camada vigente do MapBiomas no imóvel; nulos se o MapBiomas não foi carregado.
  alertas int,
  alertas_pos_corte int,
  area_alertas_pos_corte_ha double precision,
  maior_alerta_pos_corte_ha double precision,
  ultimo_alerta date
);
CREATE UNIQUE INDEX car_resumo_versao ON ref.car_resumo (versao_id);
CREATE INDEX car_resumo_uf ON ref.car_resumo (uf);

-- Resumo dos alertas de cada imóvel da UF na camada vigente do MapBiomas. Só grava as linhas que mudaram; devolve quantas.
CREATE OR REPLACE FUNCTION ref.resumir_alertas(p_uf char(2)) RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  v_camada int := ref.camada_vigente('mapbiomas');
  n int;
BEGIN
  WITH a AS (
    SELECT c.cod_imovel, count(*) AS alertas,
           count(*) FILTER (WHERE c.detectado_em > date '2020-12-31') AS pos_corte,
           coalesce(sum(c.area_ha) FILTER (WHERE c.detectado_em > date '2020-12-31'), 0) AS area_pos_corte,
           max(c.area_ha) FILTER (WHERE c.detectado_em > date '2020-12-31') AS maior_pos_corte,
           max(c.detectado_em) AS ultimo
    FROM ref.car_alerta c JOIN ref.car_resumo r USING (cod_imovel)
    WHERE r.uf = p_uf AND c.camada_id = v_camada
    GROUP BY c.cod_imovel
  ),
  novo AS (
    -- Sem camada, tudo nulo; com ela, imóvel sem alerta fica com zero.
    SELECT r.cod_imovel,
           CASE WHEN v_camada IS NOT NULL THEN coalesce(a.alertas, 0) END AS alertas,
           CASE WHEN v_camada IS NOT NULL THEN coalesce(a.pos_corte, 0) END AS pos_corte,
           CASE WHEN v_camada IS NOT NULL THEN coalesce(a.area_pos_corte, 0) END AS area_pos_corte,
           a.maior_pos_corte, a.ultimo
    FROM ref.car_resumo r LEFT JOIN a USING (cod_imovel)
    WHERE r.uf = p_uf
  )
  UPDATE ref.car_resumo r
  SET alertas = n.alertas, alertas_pos_corte = n.pos_corte, area_alertas_pos_corte_ha = n.area_pos_corte,
      maior_alerta_pos_corte_ha = n.maior_pos_corte, ultimo_alerta = n.ultimo
  FROM novo n
  WHERE r.cod_imovel = n.cod_imovel
    AND (r.alertas, r.alertas_pos_corte, r.area_alertas_pos_corte_ha, r.maior_alerta_pos_corte_ha, r.ultimo_alerta)
        IS DISTINCT FROM (n.alertas, n.pos_corte, n.area_pos_corte, n.maior_pos_corte, n.ultimo);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Refaz a ficha dos imóveis da UF cuja versão que vale mudou (versão nova, imóvel novo, imóvel que saiu da carga) e o
-- resumo dos alertas da UF. Compara a UF inteira com a tabela, então serve para qualquer carga e para corrigir uma
-- tabela desatualizada; os biomas e o ponto só são calculados para as linhas que mudaram. Devolve quantas fichas refez.
CREATE OR REPLACE FUNCTION ref.atualizar_car_resumo(p_uf char(2)) RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  v_camada int := ref.camada_vigente('mapbiomas');
  n int;
BEGIN
  WITH valem AS (
    SELECT DISTINCT ON (cod_imovel) id, cod_imovel, valido_ate IS NULL AS vigente
    FROM ref.car_imovel WHERE uf = p_uf
    ORDER BY cod_imovel, valido_ate IS NULL DESC, valido_de DESC, id DESC
  ),
  mudou AS (
    SELECT v.id, v.vigente FROM valem v LEFT JOIN ref.car_resumo r USING (cod_imovel)
    WHERE r.cod_imovel IS NULL OR r.versao_id <> v.id OR r.vigente <> v.vigente
  )
  INSERT INTO ref.car_resumo (cod_imovel, uf, versao_id, vigente, cod_ibge, municipio, area_ha, mod_fiscal, situacao, tipo,
                              condicao, criado_sicar, atualizado_sicar, valido_de, carga_id, hash, limites, centro, biomas,
                              alertas, alertas_pos_corte, area_alertas_pos_corte_ha)
  SELECT c.cod_imovel, c.uf, c.id, m.vigente, c.cod_ibge, c.municipio, c.area_ha, c.mod_fiscal, c.status, c.tipo,
         c.condicao, c.criado_sicar, c.atualizado_sicar, c.valido_de, c.carga_id, c.hash,
         ARRAY[ST_XMin(c.geom), ST_YMin(c.geom), ST_XMax(c.geom), ST_YMax(c.geom)], ST_PointOnSurface(c.geom),
         ref.biomas_da_geom(c.geom),
         -- Imóvel novo começa sem alerta (com a camada carregada); resumir_alertas grava os que têm.
         CASE WHEN v_camada IS NOT NULL THEN 0 END, CASE WHEN v_camada IS NOT NULL THEN 0 END,
         CASE WHEN v_camada IS NOT NULL THEN 0 END
  FROM mudou m JOIN ref.car_imovel c ON c.uf = p_uf AND c.id = m.id
  ON CONFLICT (cod_imovel) DO UPDATE SET
    uf = EXCLUDED.uf, versao_id = EXCLUDED.versao_id, vigente = EXCLUDED.vigente, cod_ibge = EXCLUDED.cod_ibge,
    municipio = EXCLUDED.municipio, area_ha = EXCLUDED.area_ha, mod_fiscal = EXCLUDED.mod_fiscal,
    situacao = EXCLUDED.situacao, tipo = EXCLUDED.tipo, condicao = EXCLUDED.condicao,
    criado_sicar = EXCLUDED.criado_sicar, atualizado_sicar = EXCLUDED.atualizado_sicar, valido_de = EXCLUDED.valido_de,
    carga_id = EXCLUDED.carga_id, hash = EXCLUDED.hash, limites = EXCLUDED.limites, centro = EXCLUDED.centro,
    biomas = EXCLUDED.biomas;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM ref.resumir_alertas(p_uf);
  RETURN n;
END
$$;

-- Biomas de todos os imóveis, depois de uma carga dos biomas. Só grava as linhas que mudaram; devolve quantas.
CREATE OR REPLACE FUNCTION ref.resumir_biomas() RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  n int;
BEGIN
  UPDATE ref.car_resumo r SET biomas = x.biomas
  FROM (SELECT r2.cod_imovel, ref.biomas_da_geom(c.geom) AS biomas
        FROM ref.car_resumo r2 JOIN ref.car_imovel c ON c.uf = r2.uf AND c.id = r2.versao_id) x
  WHERE r.cod_imovel = x.cod_imovel AND r.biomas IS DISTINCT FROM x.biomas;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

SELECT uf, ref.atualizar_car_resumo(uf) AS fichas FROM (SELECT DISTINCT uf FROM ref.car_carga) u;
ANALYZE ref.car_resumo;
