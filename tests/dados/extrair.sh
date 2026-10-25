#!/usr/bin/env bash
# Regera a amostra de dados reais de tests/dados/ a partir do banco local de desenvolvimento (só leitura).
#
# Uso: ./tests/dados/extrair.sh     (com o db no ar e o CAR do RS, o MapBiomas e os biomas carregados)
#
# Os imóveis são os de casos.json, todos perto de Almirante Tamandaré do Sul e Sarandi (RS), onde há imóveis
# suspensos, cancelados e pendentes no Pampa e na Mata Atlântica. Os arquivos saem com os nomes de coluna das bases
# originais, para passar pelos mesmos carregadores da pipeline:
#   AREA_IMOVEL/RS/AREA_IMOVEL_1.shp         CAR, carga 1 (.dbf em latin-1, sem .cpg, datas em texto DD/MM/AAAA)
#   carga2/AREA_IMOVEL/RS/AREA_IMOVEL_1.shp  CAR, carga 2: sem o imóvel `removido_na_carga2`, e o
#                                            `alterado_na_carga2` suspenso, com atualização posterior
#   alerts_with_intersections/…              alertas do MapBiomas sobre os imóveis e alguns vizinhos que não os tocam
#   BIOMAS/lml_bioma_e250k_v20250911_A.shp   biomas do IBGE recortados numa caixa em volta dos imóveis
#   municipios.sql                           municípios do IBGE que os imóveis tocam (a carga do CAR não baixa do IBGE)
#
# Se o banco de desenvolvimento receber um CAR mais novo, um imóvel pode mudar de situação: confira os papéis de
# casos.json (e as contagens esperadas) antes de usar a amostra regerada.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

SAIDA=tests/dados
REMOVIDO=RS-4300471-D49C9BCA8CC14846980DBE3E93CDA4F2
ALTERADO=RS-4300471-F9DB99AA6BFD42CCB19006C467181C31
# A versão do `alterado_na_carga2` na carga 2: suspenso depois da análise, atualizado no SICAR em 15/09/2026.
ALTERADO_STATUS=SU
ALTERADO_CONDICAO='Analisado, aguardando atendimento a notificacao'
ALTERADO_ATUALIZADO=15/09/2026
IMOVEIS="'RS-4300471-5B3E3D6F4D024DC1A89D86F999FAACB4','RS-4300471-F54F6899CCF54E1DB95CD457C33465A0',
'RS-4300471-3685FB0BF13A4A42A93E05D2802E46BC','RS-4320107-BE5FBC090D1A4F6281A9F0632DA87189',
'RS-4300471-0C960D38614A46C48B67656E726612FE','RS-4300471-1778C5E794DB41CAA44868301F8DFF63',
'RS-4320107-9180E6C99E2C4F47AFBF885D7FC737F8','RS-4300471-7BC4D86208E741B885327E8299B124CD',
'RS-4300471-24B4E305B8DC435BBEE925806EA67951','$REMOVIDO','$ALTERADO',
'RS-4300471-5A16847344A34F13890250C160509B90','RS-4300471-226E141EC0C64262BB7DBE077898CB2B'"
# Os três que tocam os imóveis (960891 toca dois) e quatro vizinhos, a até 4 km, que não tocam nenhum.
ALERTAS="'169928','315526','960891','800979','1350677','891194','791085'"

CAR="SELECT cod_imovel, municipio, area_ha AS num_area, mod_fiscal, status::text AS ind_status, tipo AS ind_tipo,
       condicao AS des_condic, to_char(criado_sicar, 'DD/MM/YYYY') AS dat_criaca,
       to_char(atualizado_sicar, 'DD/MM/YYYY') AS dat_atuali, geom
     FROM ref.car_imovel WHERE valido_ate IS NULL AND cod_imovel IN ($IMOVEIS)"
CAR2="SELECT cod_imovel, municipio, num_area, mod_fiscal,
       CASE WHEN cod_imovel = '$ALTERADO' THEN '$ALTERADO_STATUS' ELSE ind_status END AS ind_status, ind_tipo,
       CASE WHEN cod_imovel = '$ALTERADO' THEN '$ALTERADO_CONDICAO' ELSE des_condic END AS des_condic, dat_criaca,
       CASE WHEN cod_imovel = '$ALTERADO' THEN '$ALTERADO_ATUALIZADO' ELSE dat_atuali END AS dat_atuali, geom
     FROM ($CAR) c WHERE cod_imovel <> '$REMOVIDO' ORDER BY cod_imovel"
CAR="$CAR ORDER BY cod_imovel"
# SOURCE no formato de array do Postgres ({SAD-PAMPA,GLAD}), como no arquivo do MapBiomas.
ALERTAS_SQL="SELECT externo_id::bigint AS \"ALERTCODE\", (atributos->>'area_ha')::float8 AS \"ALERTHA\",
       '{' || array_to_string(ARRAY(SELECT jsonb_array_elements_text(atributos->'fontes')), ',') || '}' AS \"SOURCE\",
       data_evento AS \"DETECTAT\", atributos->>'classe' AS \"ALERTCLASS\", geom
     FROM ref.feicao_ambiental
     WHERE camada_id = ref.camada_vigente('mapbiomas') AND externo_id IN ($ALERTAS) ORDER BY externo_id::bigint"
# Pampa e Mata Atlântica no desenho original, recortados numa caixa 0,08° maior que a dos imóveis
# (com caixas maiores, pedaços mínimos de bioma cortados na borda somem na simplificação dos níveis 0 e 1 e quebram a
# remontagem dos polígonos: a amostra perderia um bioma nesses níveis).
CAIXA="SELECT ST_Expand(ST_SetSRID(ST_Extent(geom)::geometry, 4326), 0.08) AS caixa
       FROM ref.car_imovel WHERE valido_ate IS NULL AND cod_imovel IN ($IMOVEIS)"
BIOMAS="SELECT b.cod::int AS cd_bioma, b.nome AS nm_bioma,
       ST_Multi(ST_CollectionExtract(ST_Intersection(b.geom, c.caixa), 3)) AS geom
     FROM ref.bioma b, ($CAIXA) c WHERE b.geom && c.caixa AND ST_Intersects(b.geom, c.caixa) ORDER BY b.cod"
MUNICIPIOS="SELECT format(E'  (%s, %L, %L, %L)', m.cod_ibge, m.nome, m.uf, ST_AsText(m.geom))
     FROM ref.municipio m
     WHERE EXISTS (SELECT 1 FROM ref.car_imovel c
                   WHERE c.valido_ate IS NULL AND c.cod_imovel IN ($IMOVEIS) AND ST_Intersects(m.geom, c.geom))
     ORDER BY m.cod_ibge"

rm -rf "$SAIDA/AREA_IMOVEL" "$SAIDA/carga2" "$SAIDA/alerts_with_intersections" "$SAIDA/BIOMAS"
mkdir -p "$SAIDA/AREA_IMOVEL/RS" "$SAIDA/carga2/AREA_IMOVEL/RS" "$SAIDA/alerts_with_intersections" "$SAIDA/BIOMAS"

# ogr2ogr no contêiner da pipeline (tem o GDAL), lendo o banco de desenvolvimento e gravando em tests/dados/.
docker compose run --rm -T -v "$PWD/$SAIDA:/saida" \
  -e CAR="$CAR" -e CAR2="$CAR2" -e ALERTAS_SQL="$ALERTAS_SQL" -e BIOMAS="$BIOMAS" \
  --entrypoint bash pipeline -euo pipefail -c '
    PG=$(python3 -c "from nt_pipeline.banco import dsn_gdal; print(dsn_gdal())")
    # O SICAR publica o .dbf em latin-1 e sem .cpg.
    ogr2ogr -f "ESRI Shapefile" /saida/AREA_IMOVEL/RS/AREA_IMOVEL_1.shp "$PG" -sql "$CAR" -nln AREA_IMOVEL_1 -lco ENCODING=ISO-8859-1
    ogr2ogr -f "ESRI Shapefile" /saida/carga2/AREA_IMOVEL/RS/AREA_IMOVEL_1.shp "$PG" -sql "$CAR2" -nln AREA_IMOVEL_1 -lco ENCODING=ISO-8859-1
    rm -f /saida/AREA_IMOVEL/RS/*.cpg /saida/carga2/AREA_IMOVEL/RS/*.cpg
    ogr2ogr -f "ESRI Shapefile" /saida/alerts_with_intersections/alerts_with_intersections.shp "$PG" -sql "$ALERTAS_SQL" \
      -nln alerts_with_intersections -lco ENCODING=UTF-8
    ogr2ogr -f "ESRI Shapefile" /saida/BIOMAS/lml_bioma_e250k_v20250911_A.shp "$PG" -sql "$BIOMAS" \
      -nln lml_bioma_e250k_v20250911_A -nlt MULTIPOLYGON -lco ENCODING=UTF-8
  '

{
  echo "-- Municípios do IBGE que os imóveis da amostra tocam (malha da API do IBGE, como a carga do CAR baixaria)."
  echo "-- Gerado por tests/dados/extrair.sh. Entra antes da carga do CAR: com municípios do RS no banco, ela não vai ao IBGE."
  echo "SET client_encoding = 'UTF8';"
  echo "INSERT INTO ref.municipio (cod_ibge, nome, uf, geom, geom_3857)"
  echo "SELECT v.cod_ibge, v.nome, v.uf, g, ST_Transform(g, 3857)"
  echo "FROM (VALUES"
  docker compose exec -T db psql -U nodaltrace -d nodaltrace -Atc "$MUNICIPIOS" | sed '$!s/$/,/'
  echo ") v(cod_ibge, nome, uf, wkt), LATERAL (SELECT ST_Multi(ST_GeomFromText(v.wkt, 4326))::geometry(MultiPolygon, 4326) AS g) x;"
} > "$SAIDA/municipios.sql"

du -ach "$SAIDA"/AREA_IMOVEL "$SAIDA"/carga2 "$SAIDA"/alerts_with_intersections "$SAIDA"/BIOMAS "$SAIDA"/municipios.sql | tail -n1
