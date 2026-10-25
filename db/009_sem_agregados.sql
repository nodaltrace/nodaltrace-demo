-- O CAR com o mapa afastado (coroplético por município e grade H3) saiu do mapa: abaixo do zoom 10 o CAR não aparece.
-- Remove as funções de tile, as tabelas de agregados e as colunas que só serviam a eles.
-- Num banco novo, 001 e 003 já não criam nada disso e os comandos abaixo não fazem nada.
DROP FUNCTION IF EXISTS ref.agg_municipio_tiles(int, int, int);
DROP FUNCTION IF EXISTS ref.agg_hex_tiles(int, int, int);
DROP TABLE IF EXISTS ref.agg_municipio;
DROP TABLE IF EXISTS ref.agg_hex;
ALTER TABLE ref.car_imovel DROP COLUMN IF EXISTS h3_r5, DROP COLUMN IF EXISTS h3_r7;
ALTER TABLE ref.municipio DROP COLUMN IF EXISTS area_ha;
