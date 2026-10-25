-- As sobreposições entre imóveis do CAR saíram: o pipeline não as calcula, a análise e a camada do mapa foram removidas.
-- Num banco novo, 001 e 003 já não criam nada disso (e a 017 deixou de existir): os comandos abaixo não fazem nada.
DROP FUNCTION IF EXISTS ref.sobreposicao_tiles(int, int, int);
DROP TABLE IF EXISTS ref.car_sobreposicao_estado;
DROP TABLE IF EXISTS ref.car_sobreposicao;
