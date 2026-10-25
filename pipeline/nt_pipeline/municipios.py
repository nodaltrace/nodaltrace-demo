"""Malha municipal do IBGE: limites e nomes oficiais dos municípios (CAR, instalações e cadastro)."""

import gzip
import json
import urllib.request

from .banco import conectar
from .ufs import CODIGO_UF, validar_uf

MALHA = 'https://servicodados.ibge.gov.br/api/v3/malhas/estados/{cod}?formato=application/vnd.geo%2Bjson&qualidade=intermediaria&intrarregiao=municipio'
NOMES = 'https://servicodados.ibge.gov.br/api/v1/localidades/estados/{cod}/municipios'


def _baixar(url: str):
    with urllib.request.urlopen(url, timeout=120) as r:
        corpo = r.read()
    # O IBGE às vezes responde comprimido mesmo sem o cliente pedir.
    if corpo[:2] == b'\x1f\x8b':
        corpo = gzip.decompress(corpo)
    return json.loads(corpo)


def carregar_municipios(uf: str) -> None:
    uf = validar_uf(uf)
    cod = CODIGO_UF[uf]
    malha = _baixar(MALHA.format(cod=cod))
    nomes = {m['id']: m['nome'] for m in _baixar(NOMES.format(cod=cod))}
    with conectar() as con:
        con.execute('DELETE FROM ref.municipio WHERE uf = %s', (uf,))
        with con.cursor() as cur:
            for f in malha['features']:
                codigo = int(f['properties']['codarea'])
                cur.execute(
                    """INSERT INTO ref.municipio (cod_ibge, nome, uf, geom, geom_3857)
                       SELECT %s, %s, %s, g, ST_Transform(g, 3857)
                       FROM (SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)), 3)) AS g) x""",
                    (codigo, nomes.get(codigo, str(codigo)), uf, json.dumps(f['geometry'])),
                )
        con.commit()
    print(f'{uf}: {len(malha["features"])} municípios', flush=True)
