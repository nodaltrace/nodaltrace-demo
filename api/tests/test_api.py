"""O contrato da API (OpenAPI, snake_case) e a tradução dos erros das camadas e do banco em respostas HTTP."""

import re

from psycopg.errors import QueryCanceled

from nodaltrace.banco import TEMPO_MAX_CONSULTA, pool
from nodaltrace.main import app
from nodaltrace.servicos import imoveis


def test_respostas_em_snake_case():
    """Todo campo de toda resposta: o frontend recebe os nomes do banco e do Python, sem tradução."""
    esquemas = app.openapi()['components']['schemas']
    fora = [f'{nome}.{campo}' for nome, e in esquemas.items() for campo in e.get('properties', {})
            if not re.fullmatch(r'[a-z][a-z0-9_]*', campo) and nome not in ('HTTPValidationError', 'ValidationError')]
    assert fora == []


def test_consultas_com_tempo_maximo(api):
    with pool.connection() as con:
        assert con.execute('SHOW statement_timeout').fetchone()['statement_timeout'] == TEMPO_MAX_CONSULTA


def test_consulta_cancelada_vira_503(api, monkeypatch):
    def demorada(con, cod):
        raise QueryCanceled('canceling statement due to statement timeout')
    monkeypatch.setattr(imoveis, 'ficha', demorada)
    r = api.get('/car/RS-0000000-QUALQUER')
    assert r.status_code == 503 and 'time limit' in r.json()['detail']


def test_erro_das_camadas_vira_status_e_detail(api):
    r = api.get('/relatorios/NT-1900-000000')
    assert r.status_code == 404 and r.json() == {'detail': 'Report NT-1900-000000 not found'}


def test_tipos_ts_do_openapi():
    from nodaltrace.tipos_ts import gerar, tipo
    assert tipo({'anyOf': [{'type': 'string'}, {'type': 'null'}]}) == 'string | null'
    assert tipo({'type': 'array', 'prefixItems': [{'type': 'number'}] * 2}) == '[number, number]'
    assert tipo({'type': 'array', 'items': {'enum': ['a', "b'c"]}}) == "('a' | 'b\\'c')[]"
    assert tipo({'type': 'object', 'additionalProperties': {'type': 'integer'}}) == 'Record<string, number>'
    assert tipo({'type': 'object', 'additionalProperties': True}) == 'Record<string, unknown>'
    texto = gerar(app.openapi())
    assert 'export interface Imovel {' in texto and '  conformidade_car: Criterio\n' in texto and 'HTTPValidationError' not in texto
