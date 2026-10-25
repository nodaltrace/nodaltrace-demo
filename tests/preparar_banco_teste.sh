#!/usr/bin/env bash
# Monta o banco de testes `nodaltrace_teste` com a amostra de dados reais de tests/dados/ (ver casos.json), pelos
# mesmos comandos da pipeline que carregam as bases de verdade: migrações, CAR (carga 1), MapBiomas, biomas e CAR
# (carga 2). Apaga e recria o banco a cada execução; o banco de desenvolvimento (`nodaltrace`) não é tocado.
#
# Uso: ./tests/preparar_banco_teste.sh     (com o db no ar: docker compose up -d --wait db)
#
# Depois, os testes apontam para o banco com DATABASE_URL=postgresql://nodaltrace:<senha>@db:5432/nodaltrace_teste
# (ver ./run.sh test). Roda no bash 3.2 do macOS e no CI.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[erro]\033[0m %s\n' "$*" >&2; exit 1; }

BANCO=nodaltrace_teste
CASOS=tests/dados/casos.json
# A pipeline lê a amostra em /dados, no lugar do DADOS_DIR do .env.
export DADOS_DIR=./tests/dados
# A senha do .env, se houver (o Compose a lê de lá; este script não executa o .env).
SENHA="${POSTGRES_PASSWORD:-$(sed -n 's/^POSTGRES_PASSWORD=//p' .env 2>/dev/null | tail -n1)}"
URL="postgresql://nodaltrace:${SENHA:-nodaltrace}@db:5432/$BANCO"

# Data de referência de casos.json ("chave": "AAAA-MM-DD"): as datas ficam só lá.
data() {
  local v
  v=$(sed -n "s/^ *\"$1\": *\"\([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}\)\".*/\1/p" "$CASOS")
  [[ -n "$v" ]] || die "Sem \"$1\" em $CASOS."
  printf '%s' "$v"
}
DATA_CAR_1=$(data data_car_1)
DATA_CAR_2=$(data data_car_2)
DATA_MAPBIOMAS=$(data data_mapbiomas)

psql_teste() { docker compose exec -T db psql -U nodaltrace -d "$BANCO" -v ON_ERROR_STOP=1 -q "$@"; }
pipeline() { docker compose run --rm -T -e DATABASE_URL="$URL" pipeline "$@"; }

docker compose exec -T db pg_isready -U nodaltrace -q \
  || die "O banco não está no ar. Suba com: docker compose up -d --wait db"

log "Banco $BANCO (recriado)"
# FORCE derruba conexões que tenham ficado abertas (uma API apontada para o banco de testes, por exemplo).
docker compose exec -T db psql -U nodaltrace -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS $BANCO WITH (FORCE)" -c "CREATE DATABASE $BANCO"
psql_teste -c 'CREATE EXTENSION postgis'

log "Migrações"
pipeline migrar

log "Municípios do IBGE (tests/dados/municipios.sql)"
# Antes do CAR: com municípios do RS no banco, a carga não vai à API do IBGE.
psql_teste < tests/dados/municipios.sql

# O CAR entra sem data: a pipeline tira a de cada carga do próprio arquivo (dat_atuali mais recente), que casos.json
# registra em data_car_1 e data_car_2. O MapBiomas entra com a data de publicação, o outro caminho.
log "CAR, carga 1 (dados até $DATA_CAR_1)"
pipeline car --uf RS

log "MapBiomas Alerta (publicado em $DATA_MAPBIOMAS)"
pipeline mapbiomas --alertas /dados/alerts_with_intersections/alerts_with_intersections.shp --publicado-em "$DATA_MAPBIOMAS"

log "Biomas do IBGE"
pipeline biomas --arquivo /dados/BIOMAS/lml_bioma_e250k_v20250911_A.shp

log "CAR, carga 2 (dados até $DATA_CAR_2)"
pipeline car --uf RS --arquivo /dados/carga2/AREA_IMOVEL/RS/AREA_IMOVEL_1.shp

log "Resumo de $BANCO"
psql_teste -P footer=off <<'SQL'
SELECT id AS carga, data_referencia, dados_ate, publicado_em, registros, inseridos, alterados, removidos, descartados
FROM ref.car_carga ORDER BY id;
SELECT (SELECT count(*) FROM ref.car_imovel WHERE valido_ate IS NULL) AS imoveis_vigentes,
       (SELECT count(*) FROM ref.car_imovel) AS versoes,
       (SELECT count(*) FROM ref.municipio) AS municipios,
       (SELECT feicoes FROM ref.camada WHERE id = ref.camada_vigente('mapbiomas')) AS alertas,
       (SELECT count(*) FROM ref.car_alerta) AS pares_car_alerta,
       (SELECT string_agg(nome, ', ' ORDER BY nome) FROM ref.bioma) AS biomas;
SQL
log "Banco de testes pronto: $BANCO"
