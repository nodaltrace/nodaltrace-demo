-- Remove a renderização distante dos alertas do MapBiomas e seus dados derivados.
-- Os polígonos e os atributos originais continuam disponíveis para o mapa e as análises.
DROP FUNCTION IF EXISTS ref.alerta_grade_tiles(int, int, int, json);
-- O índice espacial dos centros também é removido ao excluir a coluna.
ALTER TABLE ref.feicao_ambiental
  DROP COLUMN IF EXISTS centro_3857,
  DROP COLUMN IF EXISTS area_ha;
