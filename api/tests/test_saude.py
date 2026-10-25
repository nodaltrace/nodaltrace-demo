"""Estado da API (GET /saude): as cargas do CAR e a versão dos tiles que o frontend põe no endereço deles."""

import re


def test_saude_traz_as_cargas_e_a_versao_dos_tiles(api, casos):
    r = api.get('/saude')
    assert r.status_code == 200
    d = r.json()
    assert d['status'] == 'ok'
    # A carga mais recente da UF, não a primeira, com a data dos dados tirada do arquivo (sem publicação informada).
    assert [(c['uf'], c['dados_ate'], c['publicado_em']) for c in d['cargas_car']] == [(casos['uf'], casos['datas']['data_car_2'], None)]
    assert re.fullmatch(r'[0-9a-f]{12}', d['versao_tiles'])
    # Estável enquanto nenhuma carga nem migração muda.
    assert api.get('/saude').json()['versao_tiles'] == d['versao_tiles']


def test_camadas_carregadas(api, casos):
    camadas = api.get('/analises/camadas').json()
    assert [(c['tipo'], c['feicoes']) for c in camadas] == [('mapbiomas', casos['esperado']['alertas'])]
    # Publicação informada na carga e, separada dela, a detecção mais recente do arquivo.
    assert (camadas[0]['publicado_em'], camadas[0]['dados_ate']) == (casos['datas']['data_mapbiomas'], casos['datas']['mapbiomas_dados_ate'])
