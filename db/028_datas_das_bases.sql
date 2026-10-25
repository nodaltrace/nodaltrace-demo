-- Datas das bases: até quando vão os dados de cada carga, tirada dos próprios dados, e a data de publicação na fonte,
-- quando informada. Até aqui só havia `data_referencia`, que por padrão era o dia da carga (--data-ref = hoje) e saía
-- nos relatórios como se fosse a data dos dados.
--
-- - dados_ate: SICAR, a atualização mais recente de um imóvel no arquivo (dat_atuali); MapBiomas, a detecção mais
--   recente (DETECTAT). Data depois do dia da carga não conta (erro na origem).
-- - publicado_em: a data de publicação (ou de extração) na fonte, informada na carga (--publicado-em); nula se não.
-- - data_referencia, nas cargas novas, é coalesce(publicado_em, dados_ate): a data que a carga representa, que vira o
--   valido_de/valido_ate das versões do CAR. Nas cargas anteriores a esta migração ela fica como está (a data em que
--   foram feitas), para não reescrever o histórico das versões; nenhuma tela nem relatório a mostra como data dos dados.

ALTER TABLE ref.car_carga ADD COLUMN dados_ate date, ADD COLUMN publicado_em date;
ALTER TABLE ref.camada ADD COLUMN dados_ate date, ADD COLUMN publicado_em date;

-- Cargas já feitas: dados_ate tirado das versões que valiam na data de referência de cada uma.
UPDATE ref.car_carga c SET dados_ate = (
  SELECT max(i.atualizado_sicar) FROM ref.car_imovel i
  WHERE i.uf = c.uf AND i.valido_de <= c.data_referencia AND (i.valido_ate IS NULL OR i.valido_ate > c.data_referencia)
    AND i.atualizado_sicar <= c.carregado_em::date
);
UPDATE ref.camada c SET dados_ate = (
  SELECT max(f.data_evento) FROM ref.feicao_ambiental f WHERE f.camada_id = c.id AND f.data_evento <= c.carregado_em::date
);
