-- Imóveis do arquivo do SICAR que a carga deixou de fora por geometria inutilizável (coordenadas fora de latitude e
-- longitude válidas, por exemplo um polígono em UTM declarado em graus). Os códigos saem no log da carga.
ALTER TABLE ref.car_carga ADD COLUMN IF NOT EXISTS descartados int;
