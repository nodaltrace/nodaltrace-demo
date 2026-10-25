"""Aplica as migrações SQL de /db em ordem, uma única vez cada."""

from .banco import conectar
from nt_db.migracoes import pasta_migracoes


def migrar() -> None:
    with conectar() as con:
        con.execute('CREATE TABLE IF NOT EXISTS public.migracao (nome text PRIMARY KEY, aplicada_em timestamptz NOT NULL DEFAULT now())')
        feitas = {r[0] for r in con.execute('SELECT nome FROM public.migracao')}
        for arquivo in sorted(pasta_migracoes().glob('*.sql')):
            if arquivo.name in feitas:
                continue
            print(f'aplicando {arquivo.name}')
            con.execute(arquivo.read_text())
            # A migração e o registro dela na mesma transação: falhou, não fica meio aplicada nem registrada.
            con.execute('INSERT INTO public.migracao (nome) VALUES (%s)', (arquivo.name,))
            con.commit()
    print('migrações em dia')
