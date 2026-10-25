#!/usr/bin/env bash
# Banco reduzido da demo do hackathon: copia o banco local para nodaltrace_demo e deixa nele só
# os imóveis ativos no SICAR, uma amostra aleatória de 25% deles espalhada pelo RS (mais os exemplos do Início), os
# alertas que tocam o RS e nenhum relatório, com uma série nova. Dados reais, só recortados. O banco de desenvolvimento
# não muda.
#
# Uso: deploy/demo/reduzir.sh     (da raiz do repositório, com o Compose de pé)
# Saída: deploy/demo/nodaltrace_demo.dump (pg_dump -Fc, fora do Git), para o pg_restore no Railway.
set -euo pipefail
cd "$(dirname "$0")/../.."

# A amostra é sempre a mesma para a mesma semente: a ordem dos imóveis é o md5 da semente com o código.
SEMENTE=${SEMENTE:-nodaltrace-demo}
FRACAO=${FRACAO:-0.25}
# Os imóveis de exemplo do Início ficam sempre, estejam ou não na amostra.
EXEMPLOS=$(grep -o 'RS-[0-9]\{7\}-[0-9A-F]\{32\}' web/src/panel/exemplos.ts | tr '\n' ' ')
DUMP=deploy/demo/nodaltrace_demo.dump

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
psql_() { docker compose exec -T db psql -U nodaltrace -v ON_ERROR_STOP=1 -q "$@"; }

# O CREATE DATABASE ... TEMPLATE exige o banco de origem sem conexões: a API e o Martin param só durante a cópia.
log "Copiando nodaltrace para nodaltrace_demo"
docker compose stop api martin
psql_ -d postgres -c 'DROP DATABASE IF EXISTS nodaltrace_demo' -c 'CREATE DATABASE nodaltrace_demo TEMPLATE nodaltrace'
docker compose start api martin

log "Recortando: $FRACAO dos imóveis ativos do RS (semente $SEMENTE) e os exemplos do Início"
psql_ -d nodaltrace_demo -v semente="$SEMENTE" -v fracao="$FRACAO" -v exemplos="$EXEMPLOS" <<'SQL'
BEGIN;
-- Só os imóveis ativos no SICAR (sem os pendentes, suspensos e cancelados), sorteados pelo estado inteiro.
CREATE TEMP TABLE manter_imovel AS
WITH ativo AS (
  SELECT cod_imovel, row_number() OVER (ORDER BY md5(:'semente' || cod_imovel)) AS n, count(*) OVER () AS total
  FROM ref.car_resumo WHERE vigente AND situacao = 'AT'
)
SELECT cod_imovel FROM ativo WHERE n <= round(total * :fracao)
UNION
SELECT cod_imovel FROM ref.car_resumo
WHERE vigente AND situacao = 'AT' AND cod_imovel = ANY (string_to_array(trim(:'exemplos'), ' '));
CREATE UNIQUE INDEX ON manter_imovel (cod_imovel);
ANALYZE manter_imovel;

-- Sem chave estrangeira entre eles: o mesmo conjunto de códigos nas três tabelas, e todas as versões de cada imóvel.
DELETE FROM ref.car_alerta a WHERE NOT EXISTS (SELECT 1 FROM manter_imovel k WHERE k.cod_imovel = a.cod_imovel);
DELETE FROM ref.car_resumo r WHERE NOT EXISTS (SELECT 1 FROM manter_imovel k WHERE k.cod_imovel = r.cod_imovel);
DELETE FROM ref.car_imovel i WHERE NOT EXISTS (SELECT 1 FROM manter_imovel k WHERE k.cod_imovel = i.cod_imovel);

-- Alertas: só os que tocam o RS (a tabela não tem UF). O contorno do estado em pedaços, para o índice espacial servir.
CREATE TEMP TABLE rs AS SELECT ST_Subdivide(ST_Union(geom), 256) AS geom FROM ref.municipio WHERE uf = 'RS';
CREATE INDEX ON rs USING gist (geom);
ANALYZE rs;
DELETE FROM ref.feicao_ambiental f WHERE NOT EXISTS (SELECT 1 FROM rs WHERE ST_Intersects(rs.geom, f.geom));

-- Contagens das cargas, que o Início mostra (alertas) ou guardam o tamanho da carga (CAR).
UPDATE ref.camada c SET feicoes = (SELECT count(*) FROM ref.feicao_ambiental f WHERE f.camada_id = c.id);
UPDATE ref.car_carga g SET registros = (SELECT count(*) FROM ref.car_imovel i WHERE i.carga_id = g.id);
SELECT ref.resumir_alertas('RS');

-- Relatórios: nenhum, e uma série nova (as contas na Solana derivam dela e não colidem com as do banco local).
SET LOCAL nodaltrace.apagar_relatorios = 'sim';
TRUNCATE app.ancoragem, app.relatorio, app.serie;
INSERT INTO app.serie DEFAULT VALUES;
COMMIT;
SQL

# Migrações só da demo (deploy/demo/0*.sql), cada uma numa transação com o registro em public.migracao, como faz o
# pipeline/nt_pipeline/migrar.py: o registro muda a versao_tiles (GET /saude), e o navegador não usa tiles guardados.
for m in deploy/demo/0*.sql; do
  log "Aplicando $(basename "$m")"
  { cat "$m"; printf "\nINSERT INTO public.migracao (nome) VALUES ('%s');\n" "$(basename "$m")"; } | psql_ -d nodaltrace_demo -1
done

log "Compactando (VACUUM FULL)"
psql_ -d nodaltrace_demo -c 'VACUUM (FULL, ANALYZE)'

psql_ -d nodaltrace_demo -At -v exemplos="$EXEMPLOS" <<'SQL'
SELECT format('municípios: %s · imóveis: %s (%s) · exemplos: %s de %s · alertas: %s · imóveis com alerta: %s · tamanho: %s',
  (SELECT count(DISTINCT cod_ibge) FROM ref.car_resumo), (SELECT count(*) FROM ref.car_resumo),
  (SELECT string_agg(situacao || ' ' || n, ', ') FROM (SELECT situacao, count(*) n FROM ref.car_resumo GROUP BY 1) s),
  (SELECT count(*) FROM ref.car_resumo WHERE cod_imovel = ANY (string_to_array(trim(:'exemplos'), ' '))),
  cardinality(string_to_array(trim(:'exemplos'), ' ')),
  (SELECT count(*) FROM ref.feicao_ambiental), (SELECT count(DISTINCT cod_imovel) FROM ref.car_alerta),
  pg_size_pretty(pg_database_size(current_database())));
SQL

log "Gerando $DUMP"
docker compose exec -T db pg_dump -U nodaltrace -Fc -d nodaltrace_demo > "$DUMP"
ls -lh "$DUMP"
