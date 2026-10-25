-- Fim das operações simuladas (as empresas que o mock gerava): o app trabalha só com os dados reais de `ref`.
-- Apaga os schemas de cada operação registrada, com os relatórios e as atestações gravados neles, e o registro das
-- operações; cria o schema `app`, com o que o próprio app grava.
--
-- As migrações-modelo das operações (002, 005, 008, 010 a 012, 014 a 016, 021, 022 e 025) saíram do repositório: num
-- banco novo elas não rodam, e num banco que já as aplicou esta apaga o que elas criaram.

DO $$
DECLARE
  op record;
BEGIN
  IF to_regclass('public.mock_dataset') IS NOT NULL THEN
    FOR op IN SELECT cadeia_schema AS operacao, analise_schema AS relatorios FROM public.mock_dataset LOOP
      EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', op.operacao);
      EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', op.relatorios);
    END LOOP;
  END IF;
END $$;
-- Bancos de antes do isolamento da Agrofel (012) ainda têm os schemas com o nome literal.
DROP SCHEMA IF EXISTS cadeia CASCADE;
DROP SCHEMA IF EXISTS analise CASCADE;
DROP TABLE IF EXISTS public.mock_dataset;

CREATE SCHEMA app;

-- Relatórios de análise emitidos: registro imutável, com o documento canônico e o SHA-256 dele.
CREATE SEQUENCE app.relatorio_seq;
CREATE TABLE app.relatorio (
  id         text PRIMARY KEY,  -- NT-AAAA-NNNNNN: ano da emissão + relatorio_seq
  emitido_em timestamptz NOT NULL,
  imoveis    text[] NOT NULL,   -- códigos do CAR analisados
  analises   text[] NOT NULL,   -- ids das análises, na ordem do catálogo
  status     text NOT NULL CHECK (status IN ('conforme', 'atencao', 'pendente', 'nao_conforme')),  -- pior entre os imóveis
  documento  text NOT NULL,     -- o JSON canônico do relatório
  hash       char(64) NOT NULL  -- SHA-256 do documento
);
CREATE INDEX relatorio_emitido ON app.relatorio (emitido_em DESC);
