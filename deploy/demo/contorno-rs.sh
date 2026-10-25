#!/usr/bin/env bash
# Contorno do RS para o mapa da demo do hackathon (web/src/map/rs.json): o RS de web/public/geo/uf.json, o mesmo das
# linhas de UF, e a máscara de tudo o que fica fora dele. A máscara deixa uma faixa de ~3 km em volta do RS, que cobre o
# desvio da simplificação das UFs (até 0,02°), para não cortar terra do RS na divisa e na costa.
#
# Uso: deploy/demo/contorno-rs.sh     (da raiz do repositório, com o Compose de pé; só lê o banco)
set -euo pipefail
cd "$(dirname "$0")/../.."

RS=$(python3 -c 'import json; print(json.dumps(next(f["geometry"] for f in json.load(open("web/public/geo/uf.json"))["features"] if f["properties"]["sigla"] == "RS")))')
docker compose exec -T db psql -U nodaltrace -d nodaltrace -At -v ON_ERROR_STOP=1 -v rs="$RS" > web/src/map/rs.json <<'SQL'
WITH rs AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:'rs'), 4326) AS g),
-- O RS com a faixa, só os anéis externos, simplificado sem chegar a menos de ~2,7 km da borda.
faixa AS (
  SELECT ST_Collect(ST_MakePolygon(ST_ExteriorRing(d.geom))) AS g
  FROM rs, ST_Dump(ST_SimplifyPreserveTopology(ST_Buffer(rs.g::geography, 3000)::geometry, 0.003)) d
),
parte AS (
  SELECT 'rs' AS parte, rs.g FROM rs
  UNION ALL SELECT 'faixa', faixa.g FROM faixa
  UNION ALL SELECT 'fora', ST_Difference(ST_MakeEnvelope(-180, -85, 180, 85, 4326), faixa.g) FROM faixa
)
SELECT json_build_object('type', 'FeatureCollection', 'features', json_agg(json_build_object(
  'type', 'Feature', 'properties', json_build_object('parte', parte), 'geometry', ST_AsGeoJSON(ST_Multi(g), 3)::json)))
FROM parte;
SQL
ls -l web/src/map/rs.json
