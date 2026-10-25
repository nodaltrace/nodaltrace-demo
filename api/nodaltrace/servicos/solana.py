"""Cliente do serviço `attestor` (docs/atestacao/CONTRATO.md §5): a API não tem chaves; pede o registro do relatório ao
attestor, que assina e envia a transação. Toda requisição leva o HMAC do segredo compartilhado. Só stdlib (urllib)."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlsplit

log = logging.getLogger(__name__)

#: Programa do Solana Attestation Service (o mesmo em devnet e mainnet).
PROGRAMA_SAS = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG'
RPC_PADRAO = {'devnet': 'https://api.devnet.solana.com', 'mainnet': 'https://api.mainnet-beta.solana.com'}
#: Schema do relatório no SAS (dominio/relatorio.SCHEMA).
SCHEMA = 'NT_RELATORIO'
#: Enviar e confirmar uma transação leva até o blockhash expirar (cerca de um minuto e meio) no attestor, que corta o
#: pedido em 180 s: a API espera mais que isso, para nunca desistir de uma transação que ainda pode entrar.
TIMEOUT_ATESTAR_S = 200
TIMEOUT_CONSULTA_S = 30
#: A /saude do attestor (PDAs da credencial e dos schemas) muda só com o setup: guardada por um tempo.
VALIDADE_SAUDE_S = 300
#: Uma falha da /saude também fica guardada, por menos tempo: o attestor fora do ar não é chamado a cada /verificacao.
VALIDADE_FALHA_SAUDE_S = 30


class ErroAttestor(Exception):
    """Resposta de erro do attestor (§5): `codigo` em simulacao, rpc, saldo, ja_existe, conflito, entrada; ou
    `indisponivel` (sem resposta, inclusive tempo esgotado), `autenticacao` (401) e `resposta` (corpo inesperado)."""

    def __init__(self, codigo: str, detalhe: str = '', status: int | None = None, corpo: dict | None = None):
        super().__init__(f'{codigo}: {detalhe}' if detalhe else codigo)
        self.codigo, self.detalhe, self.status, self.corpo = codigo, detalhe, status, corpo or {}


class Indisponivel(ErroAttestor):
    """O attestor não respondeu (rede, tempo esgotado)."""

    def __init__(self, detalhe: str):
        super().__init__('indisponivel', detalhe)


class JaExiste(ErroAttestor):
    """A conta já existe com os mesmos dados: a atestação está na rede, na `pda`."""

    @property
    def pda(self) -> str | None:
        return self.corpo.get('pda')


def url_base() -> str | None:
    return (os.environ.get('NT_ATTESTOR_URL') or '').rstrip('/') or None


def configurado() -> bool:
    """Attestor utilizável: URL e segredo, os dois não vazios (o compose passa as variáveis mesmo vazias)."""
    return url_base() is not None and bool(os.environ.get('NT_ATTESTOR_SEGREDO'))


def cluster() -> str:
    return os.environ.get('NT_SOLANA_CLUSTER') or 'devnet'


def assinatura(segredo: str, tempo: str, metodo: str, caminho: str, corpo: str) -> str:
    """hex(HMAC-SHA256(segredo, tempo \\n MÉTODO \\n caminho_com_query \\n corpo))."""
    msg = f'{tempo}\n{metodo}\n{caminho}\n{corpo}'.encode()
    return hmac.new(segredo.encode(), msg, hashlib.sha256).hexdigest()


def _requisitar(metodo: str, caminho: str, corpo: dict | None, timeout: float) -> dict:
    base = url_base()
    if base is None:
        raise Indisponivel('NT_ATTESTOR_URL not configured')
    url = base + caminho
    partes = urlsplit(url)
    assinado = partes.path + (f'?{partes.query}' if partes.query else '')
    texto = json.dumps(corpo, separators=(',', ':'), ensure_ascii=False) if corpo is not None else ''
    tempo = str(int(time.time()))
    cab = {'X-NT-Tempo': tempo, 'X-NT-Assinatura': assinatura(os.environ.get('NT_ATTESTOR_SEGREDO', ''), tempo, metodo, assinado, texto),
           'Accept': 'application/json'}
    if corpo is not None:
        cab['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=texto.encode() if corpo is not None else None, headers=cab, method=metodo)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try:
            dados = json.loads(e.read() or b'{}')
        except ValueError:
            dados = {}
        codigo = dados.get('erro') or ('autenticacao' if e.code == 401 else 'resposta')
        classe = JaExiste if codigo == 'ja_existe' else ErroAttestor
        raise classe(codigo, str(dados.get('detalhe') or e.reason or ''), e.code, dados) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise Indisponivel(str(getattr(e, 'reason', e))) from None
    except ValueError as e:
        raise ErroAttestor('resposta', f'invalid response body: {e}') from None


def atestar(nonce: str, campos: dict) -> dict:
    """POST /atestar → {pda, assinatura, slot, bloco_em, cluster}. Só o envio em segundo plano (servicos/ancoragem.py)
    chama isto, para cada relatório emitido."""
    return _requisitar('POST', '/atestar', {'schema': SCHEMA, 'nonce': nonce, 'campos': campos}, TIMEOUT_ATESTAR_S)


def consultar(nonce: str) -> dict:
    """GET /atestacao → {existe: false} ou {existe: true, pda, campos, assinatura, slot, bloco_em}."""
    return _requisitar('GET', '/atestacao?' + urlencode({'schema': SCHEMA, 'nonce': nonce}), None, TIMEOUT_CONSULTA_S)


#: (instante monotônico, resposta da /saude ou None se falhou).
_saude: tuple[float, dict | None] | None = None


def saude() -> dict | None:
    """A /saude do attestor (com cache, também da falha); None se não configurado ou fora do ar."""
    global _saude
    if not configurado():
        return None
    if _saude:
        idade = time.monotonic() - _saude[0]
        if idade < (VALIDADE_SAUDE_S if _saude[1] is not None else VALIDADE_FALHA_SAUDE_S):
            return _saude[1]
    try:
        _saude = (time.monotonic(), _requisitar('GET', '/saude', None, TIMEOUT_CONSULTA_S))
    except ErroAttestor as e:
        log.warning('attestor sem /saude: %s', e)
        _saude = (time.monotonic(), None)
    return _saude[1]


def _origem(url: str | None) -> str | None:
    """Só esquema://host[:porta] (sem usuário, caminho nem query: num RPC pago costumam levar a chave de API)."""
    if not url:
        return None
    try:
        p = urlsplit(url)
        porta = p.port
    except ValueError:
        return None
    if not p.scheme or not p.hostname:
        return None
    host = f'[{p.hostname}]' if ':' in p.hostname else p.hostname
    return f'{p.scheme}://{host}' + (f':{porta}' if porta else '')


def rede() -> dict:
    """Onde conferir os registros na rede: o cluster, o RPC (só a origem), o programa SAS, a autoridade (a identidade
    pública do NodalTrace), a credencial e o schema. As PDAs vêm da /saude do attestor (derivá-las exige as bibliotecas da
    Solana); sem ela, nulas."""
    s = saude() or {}
    c = cluster()
    return {
        'cluster': c,
        'rpc': _origem(os.environ.get('NT_SOLANA_RPC')) or RPC_PADRAO.get(c),
        'programa': s.get('programa') or PROGRAMA_SAS,
        'autoridade': os.environ.get('NT_AUTORIDADE') or s.get('autoridade'),
        'credencial': s.get('credencial'),
        'schema': s.get('schema'),
    }
