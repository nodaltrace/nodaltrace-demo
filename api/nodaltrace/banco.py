import os

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

#: Teto de cada consulta e de uma transação parada: uma consulta presa não segura a conexão (são só 8) nem o pedido.
#: Passou do teto, o Postgres cancela e a API responde 503 (main.py).
TEMPO_MAX_CONSULTA = '15s'
TEMPO_MAX_PARADO = '60s'

#: Todo SQL qualifica o schema: `ref.` para as bases reais, `app.` para o que o app grava (relatórios). Só os módulos de
#: consultas/ escrevem SQL; as rotas abrem a conexão e a passam adiante.
pool = ConnectionPool(
    os.environ['DATABASE_URL'], min_size=1, max_size=8, open=False,
    kwargs={'row_factory': dict_row,
            'options': f'-c statement_timeout={TEMPO_MAX_CONSULTA} -c idle_in_transaction_session_timeout={TEMPO_MAX_PARADO}'},
)
