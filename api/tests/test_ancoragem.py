"""Registro dos relatórios na Solana (api/nodaltrace/servicos/ancoragem.py) contra um attestor local que segue o contrato
HTTP (docs/atestacao/CONTRATO.md §5). Nada vai para a rede: a transação de verdade é testada no attestor (Surfpool) e na
devnet, à mão (README, "Atestação na Solana")."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from nodaltrace.banco import pool
from nodaltrace.dominio import relatorio as documento
from nodaltrace.servicos import ancoragem


class Attestor:
    """Attestor de mentira: guarda os pedidos e responde o que o teste mandar (`responder(metodo, caminho, corpo)`)."""

    def __init__(self):
        self.pedidos: list[tuple[str, str, dict | None]] = []
        self.responder = lambda metodo, caminho, corpo: (200, {})
        teste = self

        class H(BaseHTTPRequestHandler):
            def _tratar(self):
                n = int(self.headers.get('Content-Length') or 0)
                corpo = json.loads(self.rfile.read(n)) if n else None
                teste.pedidos.append((self.command, self.path, corpo))
                status, dados = teste.responder(self.command, self.path, corpo)
                texto = json.dumps(dados).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(texto)))
                self.end_headers()
                self.wfile.write(texto)

            do_GET = do_POST = _tratar

            def log_message(self, *_):
                pass

        self.srv = HTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.srv.server_address[1]}'


@pytest.fixture
def attestor(monkeypatch):
    a = Attestor()
    monkeypatch.setenv('NT_ATTESTOR_URL', a.url)
    monkeypatch.setenv('NT_ATTESTOR_SEGREDO', 's' * 40)
    yield a
    a.srv.shutdown()


def _emitir(api, cod) -> dict:
    r = api.post('/relatorios', json={'imoveis': [cod], 'analises': ['situacao_car']})
    assert r.status_code == 201, r.text
    return r.json()


def _registro(rid: str) -> dict:
    with pool.connection() as con:
        return con.execute('SELECT * FROM app.ancoragem WHERE relatorio = %s', (rid,)).fetchone()


def _campos(api, rid: str) -> dict:
    return documento.campos_na_rede(json.loads(api.get(f'/relatorios/{rid}/documento').content)['itens'])


def _drenar() -> None:
    while ancoragem.enviar_um():
        pass


def _confirmado(corpo: dict) -> dict:
    n = corpo['campos']['number']
    return {'pda': f'PDA{n}', 'assinatura': f'SIG{n}', 'slot': 1000 + n, 'bloco_em': '2026-10-22T14:03:09Z', 'cluster': 'devnet'}


def test_envia_o_documento_certo_e_confirma(api, cod, attestor):
    attestor.responder = lambda m, c, corpo: (200, _confirmado(corpo))
    doc = _emitir(api, cod['ativo_sem_alerta'])
    _drenar()
    campos = _campos(api, doc['id'])
    pedido = next(p[2] for p in attestor.pedidos if p[0] == 'POST' and p[2]['campos']['number'] == doc['numero'])
    assert pedido == {'schema': 'NT_RELATORIO', 'nonce': documento.nonce(doc['serie'], doc['numero']), 'campos': campos}
    assert campos['root'] == doc['raiz'] and campos['replaces'] == 0
    r = _registro(doc['id'])
    assert (r['status'], r['conta'], r['transacao'], r['slot'], r['tentativas']) == ('confirmada', f'PDA{doc["numero"]}', f'SIG{doc["numero"]}', 1000 + doc['numero'], 1)
    assert r['bloco_em'].isoformat() == '2026-10-22T14:03:09+00:00' and r['erro'] is None
    visto = api.get(f'/relatorios/{doc["id"]}').json()['ancoragem']
    assert visto['status'] == 'confirmada' and visto['transacao'] == f'SIG{doc["numero"]}'


def test_ja_na_rede_com_os_mesmos_dados_confirma_sem_transacao_nova(api, cod, attestor):
    def responder(metodo, caminho, corpo):
        if metodo == 'POST':
            return 409, {'erro': 'ja_existe', 'pda': 'PDAx'}
        campos = _campos(api, rid)
        return 200, {'existe': True, 'pda': 'PDAx', 'campos': campos, 'assinatura': 'SIGx', 'slot': 7, 'bloco_em': '2026-10-22T14:00:00Z'}

    attestor.responder = lambda m, c, corpo: (200, _confirmado(corpo))
    _drenar()
    rid = _emitir(api, cod['ativo_sem_alerta'])['id']
    attestor.responder = responder
    _drenar()
    r = _registro(rid)
    assert (r['status'], r['conta'], r['transacao'], r['slot']) == ('confirmada', 'PDAx', 'SIGx', 7)


def test_conflito_na_rede_falha_para_revisao(api, cod, attestor):
    attestor.responder = lambda m, c, corpo: (200, _confirmado(corpo))
    _drenar()
    rid = _emitir(api, cod['ativo_sem_alerta'])['id']
    attestor.responder = lambda m, c, corpo: (409, {'erro': 'conflito', 'detalhe': 'outra raiz', 'pda': 'PDAy'})
    _drenar()
    r = _registro(rid)
    assert r['status'] == 'falhou' and r['erro'].startswith('conflito')
    assert api.get('/saude').json()['ancoragem']['falhas'] >= 1


def test_erro_passageiro_tenta_de_novo_mais_tarde(api, cod, attestor):
    attestor.responder = lambda m, c, corpo: (200, _confirmado(corpo))
    _drenar()
    rid = _emitir(api, cod['ativo_sem_alerta'])['id']
    attestor.responder = lambda m, c, corpo: (503, {'erro': 'saldo', 'detalhe': 'saldo do atestador abaixo do mínimo'})
    _drenar()
    r = _registro(rid)
    assert (r['status'], r['tentativas']) == ('pendente', 1) and r['erro'].startswith('saldo')
    with pool.connection() as con:
        assert con.execute("SELECT proxima_tentativa > now() + interval '25 seconds' AS depois FROM app.ancoragem WHERE relatorio = %s",
                           (rid,)).fetchone()['depois']
        # A espera passa: a próxima tentativa confirma.
        con.execute('UPDATE app.ancoragem SET proxima_tentativa = now() WHERE relatorio = %s', (rid,))
    attestor.responder = lambda m, c, corpo: (200, _confirmado(corpo))
    _drenar()
    assert (_registro(rid)['status'], _registro(rid)['tentativas']) == ('confirmada', 2)


def test_attestor_fora_do_ar_fica_pendente(api, cod, monkeypatch):
    monkeypatch.setenv('NT_ATTESTOR_URL', 'http://127.0.0.1:9')
    monkeypatch.setenv('NT_ATTESTOR_SEGREDO', 's' * 40)
    rid = _emitir(api, cod['ativo_sem_alerta'])['id']
    _drenar()
    r = _registro(rid)
    assert r['status'] == 'pendente' and r['erro'].startswith('indisponivel')


def test_envio_interrompido_volta_para_a_fila(api, cod):
    rid = _emitir(api, cod['ativo_sem_alerta'])['id']
    with pool.connection() as con:
        con.execute("UPDATE app.ancoragem SET status = 'enviando' WHERE relatorio = %s", (rid,))
    assert ancoragem.conciliar() >= 1
    assert _registro(rid)['status'] == 'pendente'


def test_trabalhador_nao_sobe_no_banco_de_testes(attestor):
    assert ancoragem.no_banco_de_testes()
    ancoragem.iniciar()
    assert ancoragem._fio is None or not ancoragem._fio.is_alive()


def test_verificacao_publica_sem_imoveis(api, cod):
    doc = _emitir(api, cod['alerta_pos_corte_grande'])
    v = api.get(f'/verificacao/{doc["id"]}')
    assert v.status_code == 200
    v = v.json()
    assert (v['relatorio'], v['serie'], v['numero'], v['raiz']) == (doc['id'], doc['serie'], doc['numero'], doc['raiz'])
    assert v['registro']['status'] == 'pendente' and 'erro' not in v['registro'] and v['rede']['cluster']
    assert cod['alerta_pos_corte_grande'] not in json.dumps(v)
    assert api.get('/verificacao/NT-1900-000000').status_code == 404
    saude = api.get('/saude').json()['ancoragem']
    assert saude['serie'] == doc['serie'] and saude['pendentes'] >= 1 and saude['ligada'] is False
