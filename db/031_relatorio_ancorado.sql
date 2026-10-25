-- Relatórios registrados na Solana (docs/atestacao/CONTRATO.md). Cada relatório é imutável, numerado sem lacunas dentro
-- de uma série, e guarda o documento como a lista das folhas da árvore de Merkle e a raiz dela; o registro na rede fica
-- em app.ancoragem.
--
-- - Série: um UUID por banco, criado aqui. Os números do relatório são sequenciais dentro dela, e a conta de cada um na
--   rede deriva da série e do número. Um banco novo (ou o de testes, refeito a cada rodada) é outra série, então nunca
--   reaproveita um número já registrado na rede.
-- - Os relatórios emitidos antes desta migração são apagados: eram só de teste local (os da nuvem estavam nos schemas
--   das empresas simuladas, que a 026 apaga), e a série começa no 1.
-- - app.relatorio só aceita INSERT: UPDATE, DELETE e TRUNCATE dão erro, salvo com nodaltrace.apagar_relatorios = 'sim'
--   na sessão (só o `pipeline limpar` liga, para voltar o banco ao estado recém-migrado, com série nova). É proteção
--   contra acidente; a prova para terceiros é o registro na rede.

DROP TABLE app.relatorio;
DROP SEQUENCE app.relatorio_seq;

CREATE TABLE app.serie (
  unica boolean PRIMARY KEY DEFAULT true CHECK (unica),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  criada_em timestamptz NOT NULL DEFAULT now(),
  -- O último número emitido; o próximo relatório leva ultimo + 1 (UPDATE na transação da emissão: sem lacuna).
  ultimo int NOT NULL DEFAULT 0
);
INSERT INTO app.serie DEFAULT VALUES;

CREATE TABLE app.relatorio (
  id         text PRIMARY KEY,  -- NT-AAAA-NNNNNN: ano da emissão + número na série
  serie      uuid NOT NULL,
  numero     int NOT NULL CHECK (numero > 0),
  emitido_em timestamptz NOT NULL,
  imoveis    text[] NOT NULL,   -- códigos do CAR analisados, na ordem do pedido
  analises   text[] NOT NULL,   -- ids das análises, na ordem do catálogo
  status     text NOT NULL CHECK (status IN ('conforme', 'atencao', 'pendente', 'nao_conforme')),  -- pior entre os imóveis
  regras     text NOT NULL,     -- versão das regras (VERSAO_REGRAS)
  substitui  text UNIQUE REFERENCES app.relatorio (id),  -- o relatório que este corrige; cada um é substituído no máximo uma vez
  motivo     text,              -- o motivo da correção (também no cabeçalho do documento)
  documento  text NOT NULL,     -- {"itens": [...]} em JCS (RFC 8785): as folhas da árvore de Merkle
  raiz       char(64) NOT NULL UNIQUE,  -- raiz de Merkle das folhas, em hex
  UNIQUE (serie, numero),
  CHECK ((substitui IS NULL) = (motivo IS NULL))
);
CREATE INDEX relatorio_emitido ON app.relatorio (emitido_em DESC);

-- O registro de cada relatório na rede. Muda até ser confirmado; depois, não muda mais.
CREATE TABLE app.ancoragem (
  relatorio         text PRIMARY KEY REFERENCES app.relatorio (id),
  status            text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'enviando', 'confirmada', 'falhou')),
  tentativas        int NOT NULL DEFAULT 0,
  proxima_tentativa timestamptz NOT NULL DEFAULT now(),
  erro              text,
  cluster           text,
  conta             text,         -- a PDA da atestação no SAS
  transacao         text,         -- a assinatura da transação que criou a conta
  slot              bigint,
  bloco_em          timestamptz,  -- a hora do bloco
  enviada_em        timestamptz,
  confirmada_em     timestamptz
);
CREATE INDEX ancoragem_a_enviar ON app.ancoragem (proxima_tentativa) WHERE status = 'pendente';

CREATE FUNCTION app.relatorio_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('nodaltrace.apagar_relatorios', true) = 'sim' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'app.relatorio só aceita INSERT: um relatório emitido não muda nem sai (corrija com um relatório que o substitua)';
END $$;
CREATE TRIGGER relatorio_imutavel BEFORE UPDATE OR DELETE ON app.relatorio
  FOR EACH ROW EXECUTE FUNCTION app.relatorio_imutavel();
CREATE TRIGGER relatorio_sem_truncate BEFORE TRUNCATE ON app.relatorio
  FOR EACH STATEMENT EXECUTE FUNCTION app.relatorio_imutavel();

CREATE FUNCTION app.ancoragem_confirmada() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('nodaltrace.apagar_relatorios', true) = 'sim' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'confirmada' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'app.ancoragem: um registro confirmado na rede não muda, e nenhum registro sai';
END $$;
CREATE TRIGGER ancoragem_confirmada BEFORE UPDATE OR DELETE ON app.ancoragem
  FOR EACH ROW EXECUTE FUNCTION app.ancoragem_confirmada();
CREATE TRIGGER ancoragem_sem_truncate BEFORE TRUNCATE ON app.ancoragem
  FOR EACH STATEMENT EXECUTE FUNCTION app.ancoragem_confirmada();
