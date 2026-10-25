import os
from contextlib import contextmanager

import psycopg


@contextmanager
def conectar(autocommit: bool = False):
    with psycopg.connect(os.environ['DATABASE_URL'], autocommit=autocommit) as con:
        yield con
