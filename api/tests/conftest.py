"""Os testes rodam sempre no banco de testes `nodaltrace_teste`, montado por tests/preparar_banco_teste.sh com a amostra
de dados reais de tests/dados/ (./run.sh test faz tudo): nunca no banco de desenvolvimento, que eles alteram (relatórios
emitidos). Os imóveis de cada caso vêm de tests/dados/casos.json."""

import json
import os
from pathlib import Path

import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

BANCO_TESTE = 'nodaltrace_teste'


def _url_de_teste(url: str) -> str:
    """A mesma conexão, no banco de testes (a não ser que já aponte para um banco *_teste)."""
    banco = conninfo_to_dict(url).get('dbname', '')
    return url if banco.endswith('_teste') else make_conninfo(url, dbname=BANCO_TESTE)


os.environ['DATABASE_URL'] = _url_de_teste(os.environ['DATABASE_URL'])

from fastapi.testclient import TestClient  # noqa: E402  (depois de trocar o banco: banco.py lê a variável ao importar)

from nodaltrace.banco import pool  # noqa: E402
from nodaltrace.main import app  # noqa: E402

#: No container da API, tests/dados/ fica em /dados-teste (docker-compose.yml); fora dele, no repositório.
CASOS = next((p for p in (Path('/dados-teste/casos.json'), Path(__file__).parents[2] / 'tests/dados/casos.json') if p.exists()), None)


@pytest.fixture(scope='session')
def api():
    """Um cliente para a sessão de testes inteira: o ciclo de vida do app abre o pool do banco e o fecha no fim, e um
    pool fechado não reabre (um cliente por módulo derrubaria os módulos seguintes)."""
    with TestClient(app) as c:
        try:
            with pool.connection(timeout=5) as con:
                con.execute('SELECT 1 FROM ref.car_imovel LIMIT 1')
        except Exception as e:
            pytest.exit(f'Banco de testes {BANCO_TESTE} indisponível ({e}). Monte com ./tests/preparar_banco_teste.sh '
                        'ou rode ./run.sh test.', returncode=2)
        yield c


@pytest.fixture(scope='session')
def casos() -> dict:
    """tests/dados/casos.json: as datas das cargas, o código de cada papel e o que as cargas deixam no banco."""
    if CASOS is None:
        pytest.exit('tests/dados/casos.json não encontrado (no container da API fica em /dados-teste).', returncode=2)
    return json.loads(CASOS.read_text())


@pytest.fixture(scope='session')
def cod(casos) -> dict[str, str]:
    """O código do CAR de cada papel da amostra (casos.json → imoveis)."""
    return casos['imoveis']
