"""O verificador independente (docs/atestacao/verificar.py) contra o caso `relatorio` dos vetores do contrato: a raiz, as
PDAs derivadas como o cliente oficial do SAS, a leitura da conta e a conferência, com o RPC trocado por uma conta
montada aqui (nenhuma rede)."""

import base64
import copy
import importlib.util
import json
from pathlib import Path

import pytest

from test_merkle import _vetores


@pytest.fixture(scope='module')
def v():
    for p in ('/docs/atestacao/verificar.py', Path(__file__).resolve().parents[2] / 'docs/atestacao/verificar.py'):
        if Path(p).is_file():
            spec = importlib.util.spec_from_file_location('verificar', p)
            m = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(m)
            return m
    pytest.skip('docs/atestacao/verificar.py não encontrado')


@pytest.fixture(scope='module')
def caso():
    return _vetores()['relatorio']


def _conta(v, caso, dados: bytes | None = None) -> bytes:
    e = v.contas(caso['pdas']['autoridade'], caso['campos']['series'], caso['campos']['number'])
    d = dados if dados is not None else bytes.fromhex(caso['dados_sas'])
    return b'\x02' + e['nonce'] + e['credencial'] + e['schema'] + len(d).to_bytes(4, 'little') + d + b'\x09' * 32 + (0).to_bytes(8, 'little') + b'\0' * 32


def _rpc(v, caso, conta: bytes | None, bloco: int = 1_792_677_790):
    def rpc(url, metodo, params):
        if metodo == 'getAccountInfo':
            return {'value': conta and {'owner': v.PROGRAMA_SAS, 'data': [base64.b64encode(conta).decode(), 'base64']}}
        return [{'signature': 'SIG', 'slot': 7, 'blockTime': bloco}]
    return rpc


def test_pdas_como_o_cliente_oficial(v, caso):
    e = v.contas(caso['pdas']['autoridade'], caso['campos']['series'], caso['campos']['number'])
    assert {k: v.b58encode(e[k]) for k in ('credencial', 'schema', 'conta')} == {k: caso['pdas'][k] for k in ('credencial', 'schema', 'conta')}
    assert e['nonce'].hex() == caso['nonce']
    assert v.b58decode(caso['pdas']['autoridade']) == bytes([7] * 32)


def test_raiz_campos_e_leitura_dos_vetores(v, caso):
    itens, cab, raiz, problemas = v.ler_arquivo(json.loads(caso['documento']))
    assert raiz.hex() == caso['raiz'] and not problemas
    assert v.campos_esperados(cab, raiz) == caso['campos']
    assert v.ler_campos(bytes.fromhex(caso['dados_sas'])) == caso['campos']
    alvo = caso['itens'][3]
    prova = {'formato': v.FORMATO_PROVA, 'itens': [caso['itens'][0], alvo],
             'provas': {k: caso['provas'][k] for k in ('cabecalho:cabecalho', f'imovel:{alvo["id"]}')}}
    assert v.ler_arquivo(prova)[2].hex() == caso['raiz']


def test_confere_e_acusa_a_adulteracao(v, caso, monkeypatch):
    linhas = []
    monkeypatch.setattr(v, 'rpc', _rpc(v, caso, _conta(v, caso)))
    assert v.verificar(json.loads(caso['documento']), caso['pdas']['autoridade'], 'http://rpc', linhas.append)
    assert linhas[-1].startswith('CONFERE')

    adulterado = json.loads(caso['documento'])
    adulterado['itens'][2]['resultados'][0]['status'] = 'conforme'
    assert not v.verificar(adulterado, caso['pdas']['autoridade'], 'http://rpc', linhas.append)

    # Outra autoridade: outra credencial, outra conta.
    monkeypatch.setattr(v, 'rpc', _rpc(v, caso, None))
    assert not v.verificar(json.loads(caso['documento']), '11111111111111111111111111111111', 'http://rpc', linhas.append)


def test_conta_com_outro_layout_nao_confere(v, caso, monkeypatch):
    monkeypatch.setattr(v, 'rpc', _rpc(v, caso, _conta(v, caso, bytes.fromhex(caso['dados_sas']) + b'\0')))
    assert not v.verificar(json.loads(caso['documento']), caso['pdas']['autoridade'], 'http://rpc', lambda _: None)
    with pytest.raises(ValueError):
        v.ler_arquivo({'itens': [{'tipo': 'lote', 'id': 'x'}]})
    sem_formato = copy.deepcopy(caso['itens'])
    sem_formato[0]['formato'] = 'NT_LOTE'
    with pytest.raises(ValueError):
        v.ler_arquivo({'itens': sem_formato})


def test_avisa_do_bloco_longe_da_emissao(v, caso, monkeypatch):
    emissao = caso['campos']['issued_at']
    linhas = []
    monkeypatch.setattr(v, 'rpc', _rpc(v, caso, _conta(v, caso), bloco=emissao + 3))
    assert v.verificar(json.loads(caso['documento']), caso['pdas']['autoridade'], 'http://rpc', linhas.append)
    assert not any(l.startswith('  !') for l in linhas)

    # Registro tardio: confere do mesmo jeito, com o aviso.
    linhas = []
    monkeypatch.setattr(v, 'rpc', _rpc(v, caso, _conta(v, caso), bloco=emissao + 2 * 3600 + 5 * 60))
    assert v.verificar(json.loads(caso['documento']), caso['pdas']['autoridade'], 'http://rpc', linhas.append)
    assert any(l.startswith('  ! o registro saiu 2 h 5 min depois') for l in linhas)

    assert v.aviso_de_atraso(600) is None and v.aviso_de_atraso(-600) is None
    assert v.aviso_de_atraso(-3 * 86400).startswith('a emissão declarada é 3 dias depois do bloco')
    assert [v.duracao(s) for s in (601, 3600, 5400, 86400, 200000)] == ['10 min', '1 h', '1 h 30 min', '1 dia', '2 dias']
