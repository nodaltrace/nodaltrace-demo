"""Carga do MapBiomas Alerta: os alertas (com geometria) e o cruzamento deles com o CAR carregado.

Cada carga vira uma camada nova em `ref.camada` (tipo 'mapbiomas') e substitui as anteriores, que nada mais lê. A data
dos dados (`dados_ate`) é a detecção mais recente do arquivo; a de publicação, se conhecida, vem de --publicado-em.
O hash do arquivo identifica a carga: rodar de novo com o mesmo arquivo não faz nada.
O cruzamento alerta × imóvel (`ref.car_alerta`) é calculado aqui sobre a versão carregada do CAR, UF por UF, com o resumo
dos alertas na ficha de cada imóvel (`ref.car_resumo`); cada carga do CAR refaz os dos imóveis que mudaram.
"""

import hashlib
import subprocess
import time
from datetime import date
from pathlib import Path

from .banco import conectar, dsn_gdal


def _hash(arquivo: str) -> str:
    """SHA-256 do .shp e do .dbf."""
    h = hashlib.sha256()
    for ext in ('.shp', '.dbf'):
        with open(Path(arquivo).with_suffix(ext), 'rb') as f:
            while bloco := f.read(1 << 24):
                h.update(bloco)
    return h.hexdigest()


def _importar(arquivo: str, staging: str) -> None:
    # O MapBiomas publica em SIRGAS 2000 com .cpg UTF-8; a conversão para 4326 é praticamente nula.
    subprocess.run(
        [
            'ogr2ogr', '-f', 'PostgreSQL', dsn_gdal(), arquivo,
            '-nln', staging, '-overwrite',
            # Só as colunas que a camada guarda: o .dbf traz mais de 50.
            '-select', 'ALERTCODE,ALERTHA,SOURCE,DETECTAT,ALERTCLASS',
            '-nlt', 'PROMOTE_TO_MULTI', '-t_srs', 'EPSG:4326', '-makevalid',
            '-lco', 'GEOMETRY_NAME=geom', '-lco', 'SPATIAL_INDEX=NONE', '-lco', 'FID=fid', '-lco', 'PRECISION=NO',
            '-gt', '65536', '--config', 'PG_USE_COPY', 'YES',
        ],
        check=True,
    )


def carregar_mapbiomas(alertas: str, publicado_em: date | None = None) -> None:
    t0 = time.time()
    print('calculando o hash do arquivo…')
    hash_ = _hash(alertas)
    with conectar() as con:
        ja = con.execute("SELECT id FROM ref.camada WHERE tipo = 'mapbiomas' AND hash = %s", (hash_,)).fetchone()
        if ja:
            print(f'este arquivo já foi carregado (camada {ja[0]}); nada a fazer')
            return

    print(f'importando {alertas}…')
    _importar(alertas, 'ref.stg_mb_alerta')
    print(f'  importado em {time.time() - t0:.0f}s')

    with conectar() as con:
        # Detecção depois de hoje não conta (erro na origem).
        dados_ate = con.execute('SELECT max(detectat) FROM ref.stg_mb_alerta WHERE detectat <= current_date').fetchone()[0]
        data_ref = publicado_em or dados_ate
        if data_ref is None:
            raise SystemExit('nenhum alerta com data de detecção (DETECTAT) no arquivo: informe --publicado-em')
        vigente = con.execute("SELECT dados_ate FROM ref.camada WHERE id = ref.camada_vigente('mapbiomas')").fetchone()
        if vigente and vigente[0] and dados_ate and dados_ate < vigente[0]:
            raise SystemExit(f'os alertas do arquivo vão até {dados_ate:%d/%m/%Y}, antes dos da camada carregada '
                             f'({vigente[0]:%d/%m/%Y}): o arquivo é mais antigo e não substitui a camada')
        print(f'  alertas detectados até {dados_ate or "?"}; data de referência {data_ref}')
        camada = con.execute(
            """INSERT INTO ref.camada (tipo, nome, fonte, versao, arquivo, hash, data_referencia, dados_ate, publicado_em)
               VALUES ('mapbiomas', 'MapBiomas Alerta', 'MapBiomas Alerta (alertas validados)', %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (data_ref.isoformat(), alertas, hash_, data_ref, dados_ate, publicado_em),
        ).fetchone()[0]
        con.execute(f'CREATE TABLE ref.feicao_ambiental_{camada} PARTITION OF ref.feicao_ambiental FOR VALUES IN ({camada})')

        # Um alerta por código, com o que a interface e as regras usam.
        feicoes = con.execute("""
            INSERT INTO ref.feicao_ambiental (camada_id, data_evento, externo_id, atributos, geom, geom_3857)
            SELECT DISTINCT ON (alertcode) %(camada)s, detectat, alertcode::bigint::text,
                   jsonb_strip_nulls(jsonb_build_object(
                     'area_ha', alertha, 'fontes', to_jsonb(coalesce(nullif(source, ''), '{}')::text[]), 'classe', nullif(alertclass, ''))),
                   g, ST_Transform(g, 3857)
            FROM ref.stg_mb_alerta, LATERAL (SELECT ST_Multi(ST_CollectionExtract(geom, 3))::geometry(MultiPolygon, 4326) AS g) x
            WHERE alertcode IS NOT NULL AND detectat IS NOT NULL AND NOT ST_IsEmpty(g)
            ORDER BY alertcode, fid
        """, {'camada': camada}).rowcount
        print(f'  {feicoes} alertas')
        con.execute(f'ANALYZE ref.feicao_ambiental_{camada}')

        # Cruzamento com o CAR, na mesma transação: a API nunca vê a camada nova sem ele. A trava de cada UF é a da carga
        # do CAR (travar_uf): uma carga em andamento termina antes, e a próxima já cruza com esta camada.
        ufs = [r[0] for r in con.execute('SELECT DISTINCT uf FROM ref.car_carga ORDER BY uf')]
        pares = 0
        for uf in ufs:
            t = time.time()
            con.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', (f'car:{uf}',))
            n = con.execute('SELECT ref.cruzar_car_alerta(%s, %s)', (camada, uf)).fetchone()[0]
            # O resumo dos alertas na ficha de cada imóvel (ref.car_resumo); a camada nova já é a vigente nesta transação.
            fichas = con.execute('SELECT ref.resumir_alertas(%s)', (uf,)).fetchone()[0]
            pares += n
            print(f'  [{uf}] {n} pares alerta × imóvel, {fichas} fichas com alertas diferentes ({time.time() - t:.0f}s)', flush=True)
        print(f'  {pares} pares alerta × imóvel')

        # As cargas anteriores saem: nada lê camada que não seja a vigente (os pares delas vão junto, em cascata).
        for (antiga,) in con.execute("SELECT id FROM ref.camada WHERE tipo = 'mapbiomas' AND id <> %s", (camada,)).fetchall():
            con.execute(f'DROP TABLE IF EXISTS ref.feicao_ambiental_{antiga}')
            con.execute('DELETE FROM ref.camada WHERE id = %s', (antiga,))
            print(f'  camada {antiga} removida')

        con.execute('UPDATE ref.camada SET feicoes = %s WHERE id = %s', (feicoes, camada))
        con.execute('DROP TABLE ref.stg_mb_alerta')
        con.commit()

    with conectar(autocommit=True) as con:
        con.execute('ANALYZE ref.car_alerta')
    print(f'camada {camada} pronta em {time.time() - t0:.0f}s')
