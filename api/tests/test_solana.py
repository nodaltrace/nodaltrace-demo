"""Cliente do serviço attestor (api/nodaltrace/servicos/solana.py): a assinatura HMAC do contrato e a tradução dos erros, contra um
servidor HTTP local. Sem rede e sem o attestor de verdade."""

import json

import pytest

from nodaltrace.servicos import solana


def test_hmac_do_contrato():
    import hashlib
    import hmac
    esperado = hmac.new(b's', b'1700000000\nGET\n/atestacao?schema=NT_RELATORIO&nonce=ab\n', hashlib.sha256).hexdigest()
    assert solana.assinatura('s', '1700000000', 'GET', '/atestacao?schema=NT_RELATORIO&nonce=ab', '') == esperado


def test_cliente_assina_e_traduz_os_erros(monkeypatch):
    """Contra um attestor HTTP de verdade (local): assinatura sobre o caminho com a query e o corpo exato; 409
    ja_existe vira JaExiste com a PDA; porta fechada vira Indisponivel."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    vistos = []

    class H(BaseHTTPRequestHandler):
        def _responder(self, corpo):
            vistos.append((self.command, self.path, self.headers['X-NT-Tempo'], self.headers['X-NT-Assinatura'], corpo))
            ok = self.path.startswith('/atestacao')
            dados = json.dumps({'existe': False} if ok else {'erro': 'ja_existe', 'pda': 'PDAx'}).encode()
            self.send_response(200 if ok else 409)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(dados)

        def do_GET(self):
            self._responder('')

        def do_POST(self):
            self._responder(self.rfile.read(int(self.headers['Content-Length'])).decode())

        def log_message(self, *_):
            pass

    srv = HTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        monkeypatch.setenv('NT_ATTESTOR_URL', f'http://127.0.0.1:{srv.server_port}/')
        monkeypatch.setenv('NT_ATTESTOR_SEGREDO', 'segredo')
        assert solana.consultar('ab' * 32) == {'existe': False}
        with pytest.raises(solana.JaExiste) as e:
            solana.atestar('ab' * 32, {'ruleset': 'ação', 'number': 1})
        assert e.value.pda == 'PDAx' and e.value.status == 409
        for metodo, caminho, tempo, assinado, corpo in vistos:
            assert assinado == solana.assinatura('segredo', tempo, metodo, caminho, corpo)
        assert vistos[0][1] == f'/atestacao?schema=NT_RELATORIO&nonce={"ab" * 32}'
        assert json.loads(vistos[1][4]) == {'schema': 'NT_RELATORIO', 'nonce': 'ab' * 32, 'campos': {'ruleset': 'ação', 'number': 1}}
    finally:
        srv.shutdown()
        srv.server_close()
    with pytest.raises(solana.Indisponivel):
        solana.consultar('ab' * 32)
