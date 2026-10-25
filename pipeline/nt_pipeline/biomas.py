"""Carga dos biomas do IBGE (Biomas e Sistema Costeiro-Marinho do Brasil, 1:250.000).

O arquivo traz os seis biomas terrestres. Recarregar o mesmo arquivo não faz nada; um arquivo novo substitui
a carga anterior. Além do polígono original, grava partes subdivididas para três faixas de zoom: o cálculo de
área por imóvel usa as do desenho original, e os tiles usam as simplificadas com o mapa afastado. A
simplificação é pela rede de divisas: cada divisa é simplificada uma vez e os polígonos são remontados dela,
para os biomas vizinhos continuarem encaixados, sem buraco nem sobreposição.
"""

import hashlib
import subprocess
import time
from pathlib import Path

from .banco import conectar, dsn_gdal

STAGING = 'ref.stg_bioma'
#: Tolerância da simplificação, em graus, por nível (0: zoom < 5, ~5 km; 1: zoom 5 a 8, ~500 m; 2: original).
TOLERANCIA = {0: 0.05, 1: 0.005, 2: None}


def _hash(arquivo: str) -> str:
    h = hashlib.sha256()
    with open(arquivo, 'rb') as f:
        for bloco in iter(lambda: f.read(1 << 20), b''):
            h.update(bloco)
    return h.hexdigest()


def carregar_biomas(arquivo: str, edicao: str) -> None:
    t0 = time.time()
    hash_ = _hash(arquivo)
    with conectar() as con:
        if con.execute('SELECT 1 FROM ref.bioma_carga c JOIN ref.bioma b ON b.carga_id = c.id WHERE c.hash = %s LIMIT 1', (hash_,)).fetchone():
            print('este arquivo já é a carga vigente dos biomas: nada a fazer')
            return

    # SIRGAS 2000 (EPSG:4674) para WGS 84: diferença abaixo de 1 m, mas o banco é todo em 4326.
    subprocess.run(
        [
            'ogr2ogr', '-f', 'PostgreSQL', dsn_gdal(), arquivo, '-nln', STAGING, '-overwrite',
            '-nlt', 'PROMOTE_TO_MULTI', '-t_srs', 'EPSG:4326', '-makevalid',
            '-lco', 'GEOMETRY_NAME=geom', '-lco', 'FID=fid', '-lco', 'PRECISION=NO',
        ],
        check=True,
    )
    print(f'  importado em {time.time() - t0:.0f}s')

    with conectar() as con:
        carga = con.execute(
            'INSERT INTO ref.bioma_carga (arquivo, hash, edicao) VALUES (%s, %s, %s) RETURNING id', (Path(arquivo).name, hash_, edicao)
        ).fetchone()[0]
        con.execute('DELETE FROM ref.bioma_limite')
        con.execute('DELETE FROM ref.bioma')  # as partes saem em cascata
        n = con.execute(f"""
            INSERT INTO ref.bioma (cod, nome, carga_id, geom)
            SELECT cd_bioma::smallint, nm_bioma, %s, ST_Multi(ST_CollectionExtract(geom, 3)) FROM {STAGING}
        """, (carga,)).rowcount
        for nivel, tol in sorted(TOLERANCIA.items(), key=lambda x: x[1] is not None):  # o original primeiro
            if tol is None:
                con.execute("""
                    INSERT INTO ref.bioma_parte (cod, nivel, geom, geom_3857)
                    SELECT b.cod, 2, p.geom, ST_Transform(p.geom, 3857)
                    FROM ref.bioma b, LATERAL ST_Subdivide(b.geom, 256) AS p(geom)
                    WHERE ST_GeometryType(p.geom) = 'ST_Polygon'
                """)
                linhas = 'SELECT ST_LineMerge(ST_Union(ST_Boundary(geom))) AS geom FROM ref.bioma'
            else:
                # Divisas simplificadas uma vez só (a rede de linhas tem cada divisa uma vez) e os polígonos
                # remontados a partir delas: vizinhos continuam encaixados. Cada face recebe o bioma que a contém.
                linhas = f'SELECT ST_SimplifyPreserveTopology(ST_LineMerge(ST_Union(ST_Boundary(geom))), {tol}) AS geom FROM ref.bioma'
                con.execute(f"""
                    WITH l AS ({linhas}),
                    faces AS (SELECT (ST_Dump(ST_Polygonize(geom))).geom AS geom FROM l),
                    rotulo AS (
                      SELECT f.geom, (SELECT p.cod FROM ref.bioma_parte p
                                      WHERE p.nivel = 2 AND ST_Intersects(p.geom, ST_PointOnSurface(f.geom)) LIMIT 1) AS cod
                      FROM faces f
                    )
                    INSERT INTO ref.bioma_parte (cod, nivel, geom, geom_3857)
                    SELECT r.cod, %(nivel)s, p.geom, ST_Transform(p.geom, 3857)
                    FROM rotulo r, LATERAL ST_Subdivide(r.geom, 256) AS p(geom)
                    WHERE r.cod IS NOT NULL AND ST_GeometryType(p.geom) = 'ST_Polygon'
                """, {'nivel': nivel})
            con.execute(f"""
                WITH l AS ({linhas})
                INSERT INTO ref.bioma_limite (nivel, geom_3857)
                SELECT %(nivel)s, ST_Transform((d).geom, 3857)
                FROM l, LATERAL ST_Subdivide(l.geom, 256) AS p(geom), LATERAL ST_Dump(p.geom) AS d
                WHERE ST_GeometryType((d).geom) = 'ST_LineString'
            """, {'nivel': nivel})
        partes = con.execute('SELECT nivel, count(*) FROM ref.bioma_parte GROUP BY nivel ORDER BY nivel').fetchall()
        con.execute(f'DROP TABLE {STAGING}')
        # Os biomas de cada imóvel (ref.car_resumo), na mesma transação: a API nunca vê os biomas novos com os antigos
        # nas fichas. Sem as estatísticas das partes novas, o planejador não usaria o índice espacial.
        t = time.time()
        con.execute('ANALYZE ref.bioma_parte')
        fichas = con.execute('SELECT ref.resumir_biomas()').fetchone()[0]
        print(f'  biomas de {fichas} imóveis refeitos ({time.time() - t:.0f}s)')
        con.commit()
    with conectar(autocommit=True) as con:
        con.execute('ANALYZE ref.bioma_limite')
    print(f'  carga {carga}: {n} biomas, partes por nível {dict(partes)}')
    print(f'pronto em {time.time() - t0:.0f}s')
