import os
from contextlib import contextmanager
from urllib.parse import parse_qs, urlparse

from nt_db.banco import conectar


def dsn_gdal() -> str:
    """Conexão no formato que o driver PostgreSQL do GDAL entende."""
    u = urlparse(os.environ['DATABASE_URL'])
    # Nos jobs da nuvem, o socket do Cloud SQL: postgresql://usuario:senha@/banco?host=/cloudsql/<instância>
    host = u.hostname or parse_qs(u.query).get('host', [''])[0]
    return f'PG:host={host} port={u.port or 5432} dbname={u.path.lstrip("/")} user={u.username} password={u.password}'


@contextmanager
def travar_uf(uf: str):
    """Uma carga do CAR por UF de cada vez: duas do mesmo estado disputariam a tabela de staging e as versões vigentes.
    UFs diferentes carregam em paralelo. Trava de sessão: some se o processo cair."""
    with conectar(autocommit=True) as con:
        if not con.execute('SELECT pg_try_advisory_lock(hashtext(%s))', (f'car:{uf}',)).fetchone()[0]:
            print(f'aguardando outra ingestão de {uf} terminar…', flush=True)
            con.execute('SELECT pg_advisory_lock(hashtext(%s))', (f'car:{uf}',))
        try:
            yield
        finally:
            con.execute('SELECT pg_advisory_unlock(hashtext(%s))', (f'car:{uf}',))
