"""Documento do relatório (api/nodaltrace/dominio/relatorio.py) contra o caso `relatorio` dos vetores do contrato
(docs/atestacao/vetores.json), o mesmo que o attestor, o frontend e docs/atestacao/verificar.py conferem."""

import copy

from nodaltrace.dominio import merkle
from nodaltrace.dominio import relatorio as d
from test_merkle import _vetores


def _caso() -> dict:
    return _vetores()['relatorio']


def test_documento_folhas_raiz_e_provas_dos_vetores():
    c = _caso()
    itens = c['itens']
    assert d.texto(itens) == c['documento']
    assert d.ler(c['documento']) == itens
    ordem = merkle.ordenar(itens)
    assert [[i['tipo'], i['id']] for i in ordem] == c['ordem']
    assert [merkle.jcs(i).decode() for i in ordem] == c['jcs']
    assert [merkle.folha(i).hex() for i in ordem] == c['folhas']
    assert d.raiz(itens) == c['raiz']
    for item in itens:
        chave = f'{item["tipo"]}:{item["id"]}'
        assert merkle.prova(itens, item['tipo'], item['id']) == c['provas'][chave]
        assert merkle.verificar_prova(item, c['provas'][chave], c['raiz'])


def test_nonce_e_campos_na_rede_dos_vetores():
    c = _caso()
    cab = d.cabecalho(c['itens'])
    assert d.nonce(cab['serie'], cab['numero']) == c['nonce']
    assert d.campos_na_rede(c['itens']) == c['campos']
    assert c['campos']['replaces'] == cab['substitui']['numero']


def test_qualquer_mudanca_numa_folha_muda_a_raiz():
    c = _caso()
    for mexer in (
        lambda i: i[2]['resultados'][0].update(status='conforme'),
        lambda i: i[0]['regras'].update(versao='2026.2'),
        lambda i: i[1]['contagem'].update(conforme=2),
        lambda i: i[3].update(area_ha=0.10000000000000002),
    ):
        itens = copy.deepcopy(c['itens'])
        mexer(itens)
        assert d.raiz(itens) != c['raiz']


def test_visao_sem_sais_na_ordem_do_pedido():
    c = _caso()
    v = d.visao(c['itens'])
    assert v['id'] == 'NT-2026-000002' and v['numero'] == 2 and v['substitui']['numero'] == 1
    assert v['resumo'] == c['itens'][1]['contagem'] and v['status'] == 'nao_conforme'
    assert [i['cod_imovel'] for i in v['imoveis']] == [i['id'] for i in c['itens'][2:]]
    assert all('sal' not in i and 'tipo' not in i for i in v['imoveis'])


def test_prova_parcial_revela_so_o_pedido_e_confere_com_a_raiz():
    c = _caso()
    alvo = c['itens'][3]['id']
    p = d.prova(c['itens'], [alvo])
    assert p['formato'] == d.FORMATO_PROVA and p['raiz'] == c['raiz']
    assert [(i['tipo'], i['id']) for i in p['itens']] == [('cabecalho', 'cabecalho'), ('imovel', alvo)]
    for item in p['itens']:
        assert merkle.verificar_prova(item, p['provas'][f'{item["tipo"]}:{item["id"]}'], c['raiz'])
    com_resumo = d.prova(c['itens'], [], com_resumo=True)
    assert [i['tipo'] for i in com_resumo['itens']] == ['cabecalho', 'resumo']
    adulterado = {**p['itens'][1], 'status': 'nao_conforme'}
    assert not merkle.verificar_prova(adulterado, p['provas'][f'imovel:{alvo}'], c['raiz'])
