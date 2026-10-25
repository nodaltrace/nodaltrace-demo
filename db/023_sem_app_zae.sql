-- Saem as APPs do CAR (nunca carregadas; o mapa, o imóvel e o catálogo já não as leem), o zoneamento da palma (a regra
-- RB-03 saiu do conjunto do RenovaBio) e os tipos de camada PRODES e DETER (já chegam pelo MapBiomas).
-- Num banco novo, 004 e 008 já não criam nada disso: os comandos abaixo não fazem nada.
DROP FUNCTION IF EXISTS ref.app_tiles(int, int, int);
DROP TABLE IF EXISTS ref.car_app, ref.car_app_tema, ref.car_app_carga, ref.zae_palma;

-- Staging de uma carga de APP interrompida (ref.stg_app_<uf>).
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'ref' AND tablename LIKE 'stg\_app\_%' LOOP
    EXECUTE format('DROP TABLE ref.%I', t);
  END LOOP;
END
$$;

ALTER TABLE ref.camada
  DROP CONSTRAINT IF EXISTS camada_tipo_check,
  ADD CONSTRAINT camada_tipo_check CHECK (tipo IN ('embargo', 'mapbiomas'));
