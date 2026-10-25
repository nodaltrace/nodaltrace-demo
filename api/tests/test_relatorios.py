"""Catálogo de análises e relatórios (api/nodaltrace/servicos/catalogo.py, emissao.py, pdf.py) sobre a amostra do banco de
testes (tests/dados/casos.json). O banco de testes é refeito a cada rodada: os relatórios emitidos aqui ficam nele (a
tabela só aceita INSERT)."""

import json
from datetime import date

import psycopg
import pytest

from nodaltrace.banco import pool
from nodaltrace.consultas import relatorios
from nodaltrace.dominio import merkle
from nodaltrace.dominio import relatorio as documento
from nodaltrace.dominio.conformidade import VERSAO_REGRAS
from nodaltrace.formato import data
from nodaltrace.servicos.catalogo import ANALISES

TODAS = ['situacao_car', 'desmatamento_eudr', 'bioma', 'renovabio_rb01', 'renovabio_rb02']


def _emitir(api, imoveis, analises=('situacao_car',), **extra):
    r = api.post('/relatorios', json={'imoveis': list(imoveis), 'analises': list(analises), **extra})
    assert r.status_code == 201, r.text
    return r.json()


def test_catalogo_lista_as_analises_e_marca_as_sem_base(api):
    r = api.get('/relatorios/analises').json()
    assert [a['id'] for a in r] == [a.id for a in ANALISES]
    assert all((a['base'] is None) == (not a['disponivel']) for a in r)
    assert {'situacao_car'} <= {a['id'] for a in r if a['disponivel']}


def test_relatorio_guarda_as_folhas_com_a_raiz_e_gera_pdf(api, cod):
    com, sem = cod['alerta_pos_corte_grande'], cod['ativo_sem_alerta']
    cods = [com, sem]
    analises = [a['id'] for a in api.get('/relatorios/analises').json() if a['disponivel']]
    # Ordem do pedido invertida e código repetido: o relatório segue o catálogo e não duplica o imóvel.
    doc = _emitir(api, [*cods, cods[0].lower()], analises[::-1])
    assert [a['id'] for a in doc['analises']] == analises
    assert [i['cod_imovel'] for i in doc['imoveis']] == cods
    assert doc['emissor'] is None and doc['substitui'] is None and doc['substituido_por'] is None
    assert doc['id'] == f'NT-{doc["emitido_em"][:4]}-{doc["numero"]:06d}'
    assert doc['regras']['versao'] == VERSAO_REGRAS and doc['regras']['parametros']['corte_eudr'] == '2020-12-31'
    assert sum(doc['resumo'].values()) == len(cods)
    alvo = doc['imoveis'][0]
    eudr = next(x for x in alvo['resultados'] if x['analise'] == 'desmatamento_eudr')
    assert eudr['status'] == 'nao_conforme' and alvo['status'] == doc['status'] == 'nao_conforme'
    # A evidência em dados: os alertas com o id no MapBiomas, a detecção e as áreas.
    assert eudr['fatos']['alertas'] and all({'alerta', 'detectado_em', 'area_ha', 'pos_corte'} <= set(a) for a in eudr['fatos']['alertas'])
    assert doc['ancoragem']['status'] == 'pendente' and doc['ancoragem']['tentativas'] == 0 and doc['integro']

    guardado = api.get(f'/relatorios/{doc["id"]}').json()
    assert guardado == doc
    # O documento baixado é o texto guardado: quem o tem recalcula a raiz sozinho.
    baixado = api.get(f'/relatorios/{doc["id"]}/documento')
    assert baixado.status_code == 200 and 'relatorio-' in baixado.headers['content-disposition']
    itens = json.loads(baixado.content)['itens']
    assert documento.texto(itens) == baixado.text and documento.raiz(itens) == doc['raiz']
    assert [i['tipo'] for i in itens] == ['cabecalho', 'resumo', 'imovel', 'imovel']
    assert all(len(i['sal']) == 64 for i in itens[1:]) and len({i['sal'] for i in itens[1:]}) == 3
    assert any(x['id'] == doc['id'] and x['ancoragem'] == 'pendente' for x in api.get('/relatorios').json())

    pdf = api.get(f'/relatorios/{doc["id"]}/pdf')
    assert pdf.status_code == 200 and pdf.headers['content-type'] == 'application/pdf' and pdf.content.startswith(b'%PDF')


def test_prova_parcial_confere_com_a_raiz(api, cod):
    a, b = cod['alerta_pos_corte_grande'], cod['ativo_sem_alerta']
    doc = _emitir(api, [a, b], ['situacao_car', 'desmatamento_eudr'])
    p = api.post(f'/relatorios/{doc["id"]}/prova', json={'imoveis': [b.lower()]})
    assert p.status_code == 200, p.text
    p = p.json()
    assert p['raiz'] == doc['raiz'] and [i['tipo'] for i in p['itens']] == ['cabecalho', 'imovel']
    assert p['itens'][1]['id'] == b and a not in json.dumps(p)
    for item in p['itens']:
        assert merkle.verificar_prova(item, p['provas'][f'{item["tipo"]}:{item["id"]}'], doc['raiz'])
    fora = api.post(f'/relatorios/{doc["id"]}/prova', json={'imoveis': [cod['suspenso']]})
    assert fora.status_code == 422


def test_numeracao_sem_lacuna(api, cod):
    um = _emitir(api, [cod['ativo_sem_alerta']])
    # Pedido recusado não gasta número.
    assert api.post('/relatorios', json={'imoveis': ['RS-0000000-NAOEXISTE'], 'analises': ['situacao_car']}).status_code == 422
    # Emissão desfeita depois de tirar o número: o número volta.
    with pool.connection() as con:
        serie, numero = relatorios.proximo_numero(con)
        con.rollback()
    dois = _emitir(api, [cod['ativo_sem_alerta']])
    assert (serie, numero) == (dois['serie'], dois['numero'])
    assert dois['numero'] == um['numero'] + 1 and dois['serie'] == um['serie']


def test_relatorio_so_aceita_insert(api, cod):
    doc = _emitir(api, [cod['ativo_sem_alerta']])
    for sql in ("UPDATE app.relatorio SET status = 'conforme' WHERE id = %s", 'DELETE FROM app.relatorio WHERE id = %s',
                'DELETE FROM app.ancoragem WHERE relatorio = %s'):
        with pytest.raises(psycopg.errors.RaiseException), pool.connection() as con:
            con.execute(sql, (doc['id'],))
    for tabela in ('app.relatorio', 'app.ancoragem'):
        with pytest.raises(psycopg.errors.RaiseException), pool.connection() as con:
            con.execute(f'TRUNCATE {tabela} CASCADE')
    # Pendente, o registro na rede muda (o envio); confirmado, não muda mais.
    with pool.connection() as con:
        con.execute("UPDATE app.ancoragem SET status = 'confirmada', conta = 'x' WHERE relatorio = %s", (doc['id'],))
        con.rollback()
        con.execute("UPDATE app.ancoragem SET status = 'confirmada', conta = 'x' WHERE relatorio = %s", (doc['id'],))
        with pytest.raises(psycopg.errors.RaiseException):
            con.execute("UPDATE app.ancoragem SET conta = 'y' WHERE relatorio = %s", (doc['id'],))
        con.rollback()


def test_correcao_substitui_uma_vez_com_motivo(api, cod):
    original = _emitir(api, [cod['alerta_pos_corte_grande']], ['desmatamento_eudr'])
    motivo = '  Interseção do alerta revisada pela equipe técnica  '
    correcao = _emitir(api, [cod['alerta_pos_corte_grande'], cod['ativo_sem_alerta']], ['desmatamento_eudr', 'situacao_car'],
                       substitui=original['id'], motivo=motivo)
    assert correcao['substitui'] == {'relatorio': original['id'], 'numero': original['numero'], 'motivo': motivo.strip()}
    assert documento.campos_na_rede(json.loads(api.get(f'/relatorios/{correcao["id"]}/documento').content)['itens'])['replaces'] == original['numero']
    antigo = api.get(f'/relatorios/{original["id"]}').json()
    assert antigo['substituido_por']['relatorio'] == correcao['id'] and antigo['substituido_por']['motivo'] == motivo.strip()
    # O antigo continua igual: mesmo documento, mesma raiz.
    assert antigo['raiz'] == original['raiz'] and antigo['integro']
    lista = {x['id']: x for x in api.get('/relatorios', params={'limite': 100}).json()}
    assert lista[original['id']]['substituido_por'] == correcao['id'] and lista[correcao['id']]['substitui'] == original['id']

    def pedir(**extra):
        return api.post('/relatorios', json={'imoveis': [cod['ativo_sem_alerta']], 'analises': ['situacao_car'], **extra})

    assert pedir(substitui=original['id'], motivo='Outra correção do mesmo relatório').status_code == 409
    assert pedir(substitui='NT-1900-000000', motivo='Relatório que não existe').status_code == 404
    assert pedir(substitui=correcao['id']).status_code == 422
    assert pedir(substitui=correcao['id'], motivo='curto').status_code == 422
    assert pedir(motivo='Motivo sem relatório a corrigir').status_code == 422
    # A correção da correção vale (a cadeia segue pelo mais novo).
    assert pedir(substitui=correcao['id'], motivo='Segunda revisão da interseção').status_code == 201


def test_relatorio_recusa_car_inexistente_e_analise_desconhecida_ou_sem_base(api, cod):
    um = cod['ativo_sem_alerta']
    assert api.post('/relatorios', json={'imoveis': ['RS-0000000-NAOEXISTE'], 'analises': ['situacao_car']}).status_code == 422
    assert api.post('/relatorios', json={'imoveis': [um], 'analises': ['inventada']}).status_code == 422
    assert api.post('/relatorios', json={'imoveis': [], 'analises': ['situacao_car']}).status_code == 422
    sem_base = [a['id'] for a in api.get('/relatorios/analises').json() if not a['disponivel']]
    if sem_base:
        assert api.post('/relatorios', json={'imoveis': [um], 'analises': sem_base[:1]}).status_code == 422


def test_relatorio_inexistente(api):
    assert api.get('/relatorios/NT-1900-000000').status_code == 404
    assert api.get('/relatorios/NT-1900-000000/documento').status_code == 404
    assert api.post('/relatorios/NT-1900-000000/prova', json={'imoveis': []}).status_code == 404


@pytest.mark.parametrize('papel, esperado', [
    # situacao_car, desmatamento_eudr, bioma (informativo), renovabio_rb01, renovabio_rb02 → veredito do imóvel
    ('ativo_sem_alerta', ('conforme', 'conforme', None, 'conforme', 'conforme', 'conforme')),
    ('pendente', ('atencao', 'conforme', None, 'conforme', 'conforme', 'atencao')),
    ('suspenso', ('nao_conforme', 'conforme', None, 'conforme', 'nao_conforme', 'nao_conforme')),
    ('alerta_pos_corte_grande', ('conforme', 'nao_conforme', None, 'nao_conforme', 'conforme', 'nao_conforme')),
    ('alerta_pos_corte_pequeno', ('conforme', 'atencao', None, 'atencao', 'conforme', 'atencao')),
    # Alerta de 2020: antes do corte da EUDR, depois do corte do RenovaBio (27/11/2018).
    ('alerta_entre_cortes', ('conforme', 'conforme', None, 'nao_conforme', 'conforme', 'nao_conforme')),
    ('removido_na_carga2', ('atencao', 'conforme', None, 'conforme', 'atencao', 'atencao')),
])
def test_resultado_de_cada_analise_por_caso(api, cod, papel, esperado):
    doc = _emitir(api, [cod[papel]], TODAS)
    imovel = doc['imoveis'][0]
    assert (*[r['status'] for r in imovel['resultados']], imovel['status']) == esperado
    fatos = {r['analise']: r['fatos'] for r in imovel['resultados']}
    assert fatos['situacao_car']['vigente'] == (papel != 'removido_na_carga2')
    assert fatos['renovabio_rb02'] == {'situacao': fatos['situacao_car']['situacao'], 'vigente': fatos['situacao_car']['vigente']}
    if papel == 'alerta_entre_cortes':
        rb01 = next(r for r in imovel['resultados'] if r['analise'] == 'renovabio_rb01')
        assert any('X-02' in d for d in rb01['detalhes'])
        assert rb01['fatos']['sinais'] == ['X-02'] and rb01['fatos']['alertas'] and not fatos['desmatamento_eudr']['alertas'][0]['pos_corte']


def _en(iso: str) -> str:
    return data(date.fromisoformat(iso))


def test_relatorio_separa_a_emissao_das_datas_dos_dados(api, cod, casos):
    """O relatório é do dia da emissão; as bases trazem até quando vão os dados, a publicação (se informada) e a carga."""
    doc = _emitir(api, [cod['alerta_pos_corte_grande']], ['situacao_car', 'desmatamento_eudr', 'bioma'])
    datas = casos['datas']
    bases = {b['fonte']: b for b in doc['bases']}
    assert list(bases) == ['sicar', 'mapbiomas', 'bioma']
    assert (bases['sicar']['uf'], bases['sicar']['dados_ate'], bases['sicar']['publicado_em']) == ('RS', datas['data_car_2'], None)
    assert (bases['mapbiomas']['dados_ate'], bases['mapbiomas']['publicado_em']) == (datas['mapbiomas_dados_ate'], datas['data_mapbiomas'])
    assert bases['bioma']['dados_ate'] is None and bases['bioma']['versao'].endswith(' edition')
    # Instantes com precisão de segundo, como no resto do documento.
    assert all(b['carregado_em'] and '.' not in b['carregado_em'] for b in doc['bases']) and doc['emitido_em'][:10] > datas['data_mapbiomas']
    # O texto de cada base e as evidências citam as datas dos dados, não a da carga.
    textos = {a['id']: a['base'] for a in doc['analises']}
    assert f'updates through {_en(datas["data_car_2"])}' in textos['situacao_car']
    assert f'alerts detected through {_en(datas["mapbiomas_dados_ate"])}' in textos['desmatamento_eudr']
    assert f'published on {_en(datas["data_mapbiomas"])}' in textos['desmatamento_eudr']
    eudr = next(r for r in doc['imoveis'][0]['resultados'] if r['analise'] == 'desmatamento_eudr')
    assert eudr['resumo'].endswith(f'alert data through {_en(datas["mapbiomas_dados_ate"])}')
    # Só as bases das análises escolhidas (e o SICAR, de onde vêm os imóveis).
    so_car = _emitir(api, [cod['ativo_sem_alerta']], ['bioma'])
    assert [b['fonte'] for b in so_car['bases']] == ['sicar', 'bioma']
