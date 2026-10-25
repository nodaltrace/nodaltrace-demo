-- Dados de referência reais: CAR (SICAR), municípios (IBGE) e camadas ambientais.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS ref;

-- Cada arquivo carregado de uma UF é uma carga. Os imóveis guardam em que carga entraram.
CREATE TABLE ref.car_carga (
  id serial PRIMARY KEY,
  uf char(2) NOT NULL,
  arquivo text NOT NULL,
  data_referencia date NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now(),
  registros int,
  inseridos int,
  alterados int,
  removidos int
);

-- Histórico do CAR (SCD2): uma linha por versão de imóvel. A versão vigente tem valido_ate nulo.
-- Particionado por UF: recarregar um estado só toca a partição dele.
CREATE TABLE ref.car_imovel (
  id bigint GENERATED ALWAYS AS IDENTITY,
  uf char(2) NOT NULL,
  cod_imovel text NOT NULL,
  cod_ibge int,
  municipio text,
  area_ha double precision,
  mod_fiscal double precision,
  status char(2),
  tipo text,
  condicao text,
  criado_sicar date,
  atualizado_sicar date,
  hash bytea NOT NULL,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  geom_3857 geometry(MultiPolygon, 3857) NOT NULL,
  carga_id int NOT NULL REFERENCES ref.car_carga,
  valido_de date NOT NULL,
  valido_ate date,
  PRIMARY KEY (uf, id)
) PARTITION BY LIST (uf);

CREATE UNIQUE INDEX car_imovel_vigente ON ref.car_imovel (uf, cod_imovel) WHERE valido_ate IS NULL;
CREATE INDEX car_imovel_cod ON ref.car_imovel (cod_imovel);
CREATE INDEX car_imovel_geom ON ref.car_imovel USING gist (geom);
CREATE INDEX car_imovel_geom_3857 ON ref.car_imovel USING gist (geom_3857);
CREATE INDEX car_imovel_ibge ON ref.car_imovel (cod_ibge) WHERE valido_ate IS NULL;

CREATE TABLE ref.municipio (
  cod_ibge int PRIMARY KEY,
  nome text NOT NULL,
  uf char(2) NOT NULL,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  geom_3857 geometry(MultiPolygon, 3857) NOT NULL
);
CREATE INDEX municipio_geom_3857 ON ref.municipio USING gist (geom_3857);

-- Camadas ambientais: o MapBiomas Alerta (pipeline mapbiomas) e os embargos do IBAMA (estrutura pronta, ainda sem carga).
CREATE TABLE ref.camada (
  id serial PRIMARY KEY,
  tipo text NOT NULL CHECK (tipo IN ('embargo', 'mapbiomas')),
  nome text NOT NULL,
  fonte text NOT NULL,
  versao text NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ref.feicao_ambiental (
  id bigint GENERATED ALWAYS AS IDENTITY,
  camada_id int NOT NULL REFERENCES ref.camada,
  data_evento date,
  atributos jsonb NOT NULL DEFAULT '{}',
  geom geometry(MultiPolygon, 4326) NOT NULL,
  PRIMARY KEY (camada_id, id)
) PARTITION BY LIST (camada_id);
CREATE INDEX feicao_ambiental_geom ON ref.feicao_ambiental USING gist (geom);
