"""Volta o banco ao estado de logo depois das migrações: sem nada do que a pipeline e o app gravaram.

Apaga as referências (CAR, municípios, MapBiomas, biomas), com as partições por UF/camada e os stagings que as
cargas criam, e os relatórios emitidos (`app`), que recomeçam numa série nova: os números da série antiga podem já
estar registrados na Solana. Ficam as tabelas e as funções de tile. Os arquivos de /dados não são tocados.
"""

from psycopg import sql

from .banco import conectar

def _tabelas(con, schema: str) -> list[str]:
    # Tabelas comuns e particionadas, sem as partições (o TRUNCATE do pai já as alcança).
    return [r[0] for r in con.execute(
        """SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = %s AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1""", (schema,))]


def _esvaziar(con, schema: str) -> None:
    if tabelas := _tabelas(con, schema):
        con.execute(sql.SQL('TRUNCATE {} RESTART IDENTITY CASCADE').format(
            sql.SQL(', ').join(sql.Identifier(schema, t) for t in tabelas)))
    # RESTART IDENTITY só alcança as sequências das colunas; as avulsas voltam aqui.
    for (seq,) in con.execute('SELECT sequencename FROM pg_sequences WHERE schemaname = %s', (schema,)).fetchall():
        con.execute(sql.SQL('ALTER SEQUENCE {} RESTART').format(sql.Identifier(schema, seq)))


def limpar() -> None:
    with conectar() as con:
        if con.execute("SELECT to_regclass('app.relatorio')").fetchone()[0] is None:
            raise SystemExit('banco sem migrações: nada a limpar (rode `docker compose run --rm pipeline migrar`)')
        # Partições criadas pelas cargas (car_imovel_<uf>, feicao_ambiental_<camada>) e stagings
        # deixados por uma carga interrompida: nenhum existe num banco recém-migrado.
        criadas = [r[0] for r in con.execute(
            r"""SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'ref' AND c.relkind IN ('r', 'p') AND (c.relispartition OR c.relname LIKE 'stg\_%')""")]
        for t in criadas:
            con.execute(sql.SQL('DROP TABLE IF EXISTS {}').format(sql.Identifier('ref', t)))
        _esvaziar(con, 'ref')
        # app.relatorio e app.ancoragem recusam DELETE e TRUNCATE sem esta marca (db/031_relatorio_ancorado.sql).
        con.execute("SET LOCAL nodaltrace.apagar_relatorios = 'sim'")
        _esvaziar(con, 'app')
        con.execute('INSERT INTO app.serie DEFAULT VALUES')

        # Metadados que o ogr2ogr cria na primeira importação.
        con.execute('DROP SCHEMA IF EXISTS ogr_system_tables CASCADE')
        con.commit()
    print(f'referências e relatórios apagados ({len(criadas)} partições/stagings removidos); relatórios numa série nova; '
          'banco no estado inicial')
