"""Registro dos relatórios na Solana, em segundo plano (docs/atestacao/CONTRATO.md §6).

Todo relatório nasce com o registro pendente (app.ancoragem, na transação da emissão). Um único trabalhador, numa thread
da API, manda os pendentes ao attestor em ordem de número: confirmado, guarda a conta, a transação, o slot e a hora do
bloco; erro passageiro (rede, saldo, attestor fora do ar), tenta de novo mais tarde, esperando cada vez mais; erro
definitivo (a conta do número existe com outro documento, ou o attestor recusa o pedido), marca `falhou` para revisão.

Reenviar é seguro: a conta de cada relatório deriva da série e do número, então um reenvio do mesmo documento cai na
mesma conta (`ja_existe`) e é confirmado sem transação nova. Por isso, na subida, o que ficou `enviando` (a API caiu no
meio de um envio) volta a pendente e é reenviado.

O trabalhador só sobe com o attestor configurado e nunca no banco de testes (`*_teste`): os testes não tocam a rede.
"""

from __future__ import annotations

import logging
import os
import threading
from datetime import datetime

import psycopg
from psycopg.conninfo import conninfo_to_dict

from ..banco import pool
from ..dominio import relatorio as documento
from . import solana

log = logging.getLogger(__name__)

#: Sem aviso de relatório novo, o trabalhador olha a fila a cada INTERVALO_S.
INTERVALO_S = 30
#: Espera depois do n-ésimo erro passageiro: ESPERA_BASE_S · 2ⁿ⁻¹, até ESPERA_MAX_S.
ESPERA_BASE_S = 30
ESPERA_MAX_S = 3600
#: Erros que nenhuma nova tentativa resolve: a conta do número existe com outro documento, ou o pedido é inválido.
DEFINITIVOS = {'conflito', 'entrada'}
#: Chave da trava consultiva (pg_try_advisory_lock) que garante um trabalhador só, mesmo com várias APIs.
TRAVA = 0x4E54_414E  # 'NTAN'

_acordar = threading.Event()
_parar = threading.Event()
_fio: threading.Thread | None = None


def no_banco_de_testes(url: str | None = None) -> bool:
    return conninfo_to_dict(url or os.environ['DATABASE_URL']).get('dbname', '').endswith('_teste')


def acordar() -> None:
    """Avisa que há relatório novo (a emissão chama depois do commit)."""
    _acordar.set()


def iniciar() -> None:
    global _fio
    if not solana.configurado():
        log.info('atestação na Solana desligada (sem NT_ATTESTOR_URL/NT_ATTESTOR_SEGREDO): os relatórios ficam pendentes')
        return
    if no_banco_de_testes():
        log.warning('banco de testes: o registro na Solana não sobe')
        return
    _parar.clear()
    _fio = threading.Thread(target=_laco, name='ancoragem', daemon=True)
    _fio.start()


def parar() -> None:
    _parar.set()
    _acordar.set()
    if _fio:
        _fio.join(timeout=5)


def _laco() -> None:
    try:
        # A trava fica com esta conexão (fora do pool) enquanto o trabalhador vive: um só trabalhador por banco.
        with psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as trava:
            while not trava.execute('SELECT pg_try_advisory_lock(%s)', (TRAVA,)).fetchone()[0]:
                if _esperar():
                    return
            log.info('registro na Solana: trabalhador no ar (%s)', solana.cluster())
            conciliar()
            while True:
                try:
                    while not _parar.is_set() and enviar_um():
                        pass
                except Exception:
                    log.exception('registro na Solana: erro inesperado; tento de novo em %s s', INTERVALO_S)
                if _esperar():
                    return
    except Exception:
        log.exception('registro na Solana: o trabalhador parou')


def _esperar() -> bool:
    """Dorme até o próximo aviso ou INTERVALO_S; True se é para parar."""
    _acordar.wait(INTERVALO_S)
    _acordar.clear()
    return _parar.is_set()


def conciliar() -> int:
    """Na subida: o que ficou `enviando` volta a pendente, para reenviar já (o reenvio é idempotente). Devolve quantos."""
    with pool.connection() as con:
        n = con.execute(
            """UPDATE app.ancoragem SET status = 'pendente', proxima_tentativa = now(), erro = 'send interrupted; resent'
               WHERE status = 'enviando'""",
        ).rowcount
    if n:
        log.warning('registro na Solana: %s envio(s) interrompido(s) voltam para a fila', n)
    return n


def enviar_um() -> bool:
    """Manda ao attestor o pendente mais antigo (por número) que já pode ser tentado. False se não havia nenhum."""
    with pool.connection() as con:
        r = con.execute(
            """SELECT a.relatorio, a.tentativas, r.documento
               FROM app.ancoragem a JOIN app.relatorio r ON r.id = a.relatorio
               WHERE a.status = 'pendente' AND a.proxima_tentativa <= now()
               ORDER BY r.serie, r.numero LIMIT 1
               FOR UPDATE OF a SKIP LOCKED""",
        ).fetchone()
        if not r:
            return False
        con.execute(
            "UPDATE app.ancoragem SET status = 'enviando', enviada_em = now(), tentativas = tentativas + 1 WHERE relatorio = %s",
            (r['relatorio'],),
        )
    rid, tentativa = r['relatorio'], r['tentativas'] + 1
    campos = documento.campos_na_rede(documento.ler(r['documento']))
    nonce = documento.nonce(campos['series'], campos['number'])
    try:
        try:
            resultado = solana.atestar(nonce, campos)
        except solana.JaExiste:
            # Já está na rede com os mesmos dados (um envio anterior entrou): lê a transação que criou a conta.
            resultado = _lido(nonce, campos)
        if not resultado.get('bloco_em'):
            # O RPC ainda não tinha a hora do bloco logo depois da confirmação: a leitura da conta tenta de novo.
            resultado = {**resultado, 'bloco_em': _lido(nonce, campos).get('bloco_em')}
    except solana.ErroAttestor as e:
        _falhou(rid, tentativa, e)
        return True
    _confirmar(rid, resultado)
    log.info('registro na Solana: %s confirmado (%s)', rid, resultado.get('assinatura'))
    return True


def _lido(nonce: str, campos: dict) -> dict:
    lida = solana.consultar(nonce)
    if not lida.get('existe') or lida.get('campos') != campos:
        raise solana.ErroAttestor('conflito', 'the on-chain account for this number does not hold this report\'s data')
    return lida


def _confirmar(rid: str, r: dict) -> None:
    with pool.connection() as con:
        con.execute(
            """UPDATE app.ancoragem SET status = 'confirmada', erro = NULL, cluster = %s, conta = %s, transacao = %s, slot = %s,
                      bloco_em = %s, confirmada_em = now()
               WHERE relatorio = %s""",
            (r.get('cluster') or solana.cluster(), r['pda'], r.get('assinatura'), r.get('slot'),
             datetime.fromisoformat(r['bloco_em']) if r.get('bloco_em') else None, rid),
        )


def _falhou(rid: str, tentativa: int, e: solana.ErroAttestor) -> None:
    definitivo = e.codigo in DEFINITIVOS
    espera = min(ESPERA_BASE_S * 2 ** (tentativa - 1), ESPERA_MAX_S)
    erro = f'{e.codigo}: {e.detalhe}' if e.detalhe else e.codigo
    with pool.connection() as con:
        con.execute(
            """UPDATE app.ancoragem SET status = %s, erro = %s, proxima_tentativa = now() + make_interval(secs => %s)
               WHERE relatorio = %s""",
            ('falhou' if definitivo else 'pendente', erro[:500], espera, rid),
        )
    if definitivo:
        log.error('registro na Solana: %s FALHOU (%s); precisa de revisão', rid, erro)
    else:
        log.warning('registro na Solana: %s não registrado (%s); nova tentativa em %s s', rid, erro, espera)
