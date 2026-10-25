"""Relatórios emitidos (app.relatorio, só INSERT) e o registro de cada um na Solana (app.ancoragem)."""

from __future__ import annotations

from datetime import datetime

from psycopg import Connection


def proximo_numero(con: Connection) -> tuple[str, int]:
    """(série, número) do próximo relatório. O UPDATE trava a linha da série até o fim da transação da emissão: dois
    relatórios ao mesmo tempo saem um depois do outro, e uma emissão desfeita devolve o número (sem lacuna)."""
    r = con.execute('UPDATE app.serie SET ultimo = ultimo + 1 RETURNING id, ultimo').fetchone()
    return str(r['id']), r['ultimo']


def gravar(con: Connection, *, id_: str, serie: str, numero: int, emitido_em: datetime, cods: list[str], analises: list[str],
           status: str, regras: str, substitui: str | None, motivo: str | None, texto: str, raiz: str) -> None:
    """Grava o relatório e o registro dele na rede, pendente, na mesma transação: nenhum relatório fica sem registro."""
    con.execute(
        """INSERT INTO app.relatorio (id, serie, numero, emitido_em, imoveis, analises, status, regras, substitui, motivo, documento, raiz)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (id_, serie, numero, emitido_em, cods, analises, status, regras, substitui, motivo, texto, raiz),
    )
    con.execute('INSERT INTO app.ancoragem (relatorio) VALUES (%s)', (id_,))


def recentes(con: Connection, limite: int) -> list[dict]:
    return con.execute(
        """SELECT r.id, r.numero, r.emitido_em, r.status, cardinality(r.imoveis) AS imoveis, cardinality(r.analises) AS analises,
                  a.status AS ancoragem, r.substitui, s.id AS substituido_por
           FROM app.relatorio r
           JOIN app.ancoragem a ON a.relatorio = r.id
           LEFT JOIN app.relatorio s ON s.substitui = r.id
           ORDER BY r.emitido_em DESC, r.numero DESC LIMIT %s""",
        (limite,),
    ).fetchall()


#: As colunas do registro na rede que as respostas mostram (Ancoragem).
COLUNAS_ANCORAGEM = ('status', 'erro', 'tentativas', 'cluster', 'conta', 'transacao', 'slot', 'bloco_em', 'confirmada_em')


def guardado(con: Connection, rid: str) -> dict | None:
    """O documento, a raiz registrada na emissão, o registro na rede (colunas `a_*`) e o relatório que substitui este
    (`s_*`, nulas se nenhum); None se o relatório não existe."""
    return con.execute(
        f"""SELECT r.documento, r.raiz, {', '.join(f'a.{c} AS a_{c}' for c in COLUNAS_ANCORAGEM)},
                   s.id AS s_relatorio, s.emitido_em AS s_emitido_em, s.motivo AS s_motivo
            FROM app.relatorio r
            JOIN app.ancoragem a ON a.relatorio = r.id
            LEFT JOIN app.relatorio s ON s.substitui = r.id
            WHERE r.id = %s""",
        (rid,),
    ).fetchone()


def fila_da_ancoragem(con: Connection) -> dict:
    """A série do banco e quantos relatórios ainda não estão na rede (pendentes ou em envio) ou falharam."""
    return con.execute(
        """SELECT s.id::text AS serie,
                  (SELECT count(*) FROM app.ancoragem WHERE status IN ('pendente', 'enviando')) AS pendentes,
                  (SELECT count(*) FROM app.ancoragem WHERE status = 'falhou') AS falhas
           FROM app.serie s""",
    ).fetchone()


def verificacao(con: Connection, rid: str) -> dict | None:
    """O que a verificação pública mostra de um relatório: os dados do registro (nada dos imóveis nem dos resultados), o
    registro na rede (`a_*`) e o relatório que o substitui (`s_*`); None se não existe."""
    return con.execute(
        f"""SELECT r.id, r.serie::text AS serie, r.numero, r.emitido_em, r.regras, r.raiz, r.substitui,
                   {', '.join(f'a.{c} AS a_{c}' for c in COLUNAS_ANCORAGEM)},
                   s.id AS s_relatorio, s.emitido_em AS s_emitido_em, s.motivo AS s_motivo
            FROM app.relatorio r
            JOIN app.ancoragem a ON a.relatorio = r.id
            LEFT JOIN app.relatorio s ON s.substitui = r.id
            WHERE r.id = %s""",
        (rid,),
    ).fetchone()


def para_corrigir(con: Connection, rid: str) -> dict | None:
    """Série e número do relatório a corrigir e o id do que já o substitui, se houver; None se não existe."""
    return con.execute(
        """SELECT r.serie::text AS serie, r.numero, s.id AS substituido_por
           FROM app.relatorio r LEFT JOIN app.relatorio s ON s.substitui = r.id
           WHERE r.id = %s""",
        (rid,),
    ).fetchone()
