"""Imóveis do CAR (GET /car/{cod}, POST /car/resumo, GET /car/feicao/{id}), os tiles do CAR e as regras em vigor (GET
/analises/regras), sobre a amostra do banco de testes (tests/dados/casos.json)."""

import math

import pytest

from nodaltrace.banco import pool


@pytest.mark.parametrize('papel, situacao, status', [
    ('ativo_sem_alerta', 'AT', 'conforme'), ('pendente', 'PE', 'atencao'), ('suspenso', 'SU', 'nao_conforme'),
    ('cancelado', 'CA', 'nao_conforme'),
])
def test_situacao_no_sicar_como_criterio(api, cod, papel, situacao, status):
    d = api.get(f'/car/{cod[papel]}').json()
    assert d['vigente'] is True and d['situacao'] == situacao and d['conformidade_car']['status'] == status
    assert d['conformidade_car']['evidencia'] and d['situacao_rotulo'] != situacao


def test_imovel_fora_da_carga_mais_recente_pede_revisao(api, cod, casos):
    d = api.get(f'/car/{cod["removido_na_carga2"]}').json()
    assert d['vigente'] is False and d['situacao'] == 'AT' and d['conformidade_car']['status'] == 'atencao'
    assert d['versoes'][0]['valido_ate'] == casos['datas']['data_car_2']


def test_historico_de_versoes(api, cod, casos):
    esperado = casos['esperado']['alterado_na_carga2']
    d = api.get(f'/car/{cod["alterado_na_carga2"]}').json()
    assert [v['situacao'] for v in d['versoes']] == [esperado['depois']['status'], esperado['antes']['status']]
    assert [v['conformidade'] for v in d['versoes']] == ['nao_conforme', 'conforme']
    assert d['versoes'][0]['valido_ate'] is None and d['versoes'][1]['valido_ate'] == d['versoes'][0]['valido_de']
    assert d['condicao'] == esperado['depois']['condicao'] and d['atualizado_sicar'] == esperado['depois']['atualizado_sicar']


def test_pequena_propriedade(api, cod):
    assert api.get(f'/car/{cod["pequena_propriedade"]}').json()['pequena_propriedade'] is True
    assert api.get(f'/car/{cod["grande_sem_alerta"]}').json()['pequena_propriedade'] is False


def test_alertas_e_criterio_eudr(api, cod):
    grande = api.get(f'/car/{cod["alerta_pos_corte_grande"]}').json()
    assert grande['eudr']['status'] == 'nao_conforme'
    assert [(a['alerta'], a['pos_corte'], a['status']) for a in grande['alertas']] == [('960891', True, 'nao_conforme')]
    # O mesmo alerta, com só 0,16 ha dentro do imóvel: revisão, não reprovação.
    pequeno = api.get(f'/car/{cod["alerta_pos_corte_pequeno"]}').json()
    assert pequeno['eudr']['status'] == 'atencao' and pequeno['alertas'][0]['status'] == 'atencao'
    assert pequeno['alertas'][0]['area_ha'] < 1 < pequeno['alertas'][0]['area_alerta_ha']
    antes = api.get(f'/car/{cod["alerta_so_antes_do_corte"]}').json()
    assert antes['eudr']['status'] == 'conforme' and (antes['alertas'][0]['pos_corte'], antes['alertas'][0]['status']) == (False, None)
    sem = api.get(f'/car/{cod["ativo_sem_alerta"]}').json()
    assert sem['alertas'] == [] and sem['eudr']['status'] == 'conforme'


def test_biomas(api, cod):
    for papel, nome in (('pampa', 'Pampa'), ('mata_atlantica', 'Atlantic Forest')):
        biomas = api.get(f'/car/{cod[papel]}').json()['biomas']
        assert [b['nome'] for b in biomas] == [nome] and biomas[0]['fracao'] == pytest.approx(1, abs=1e-4)


def test_imovel_inexistente(api):
    assert api.get('/car/RS-0000000-NAOEXISTE').status_code == 404


def test_resumo_traz_rotulo_e_conformidade(api, cod):
    pedidos = [cod['suspenso'], cod['removido_na_carga2'], 'RS-0000000-NAOEXISTE']
    r = {x['cod_imovel']: x for x in api.post('/car/resumo', json={'cods': [c.lower() for c in pedidos]}).json()}
    assert set(r) == set(pedidos[:2])
    assert (r[cod['suspenso']]['situacao_rotulo'], r[cod['suspenso']]['conformidade']) == ('Suspended', 'nao_conforme')
    assert (r[cod['removido_na_carga2']]['vigente'], r[cod['removido_na_carga2']]['conformidade']) == (False, 'atencao')


def test_resumo_aceita_a_selecao_inteira_e_recusa_acima_do_limite(api, casos):
    # Os códigos vão no corpo: 500 deles somam 23 KB, que numa URL passariam do limite do nginx (8 KB).
    reais = casos['esperado']['imoveis_carga_1']
    r = api.post('/car/resumo', json={'cods': reais + [f'RS-0000000-{n:032X}' for n in range(500 - len(reais))]})
    assert r.status_code == 200 and {x['cod_imovel'] for x in r.json()} == set(reais)
    assert api.post('/car/resumo', json={'cods': reais * 50}).status_code == 422


def test_feicao_dos_tiles_leva_ao_imovel(api, cod):
    r = {x['cod_imovel']: x for x in api.post('/car/resumo', json={'cods': [cod['ativo_sem_alerta'], cod['removido_na_carga2']]}).json()}
    ativo, removido = r[cod['ativo_sem_alerta']], r[cod['removido_na_carga2']]
    o, s, l, n = ativo['limites']
    assert o <= ativo['centro'][0] <= l and s <= ativo['centro'][1] <= n
    assert api.get(f'/car/feicao/{ativo["feicao"]}').json() == ativo
    # Fora do SICAR o imóvel não está nos tiles: sem feição.
    assert removido['feicao'] is None
    assert api.get('/car/feicao/999999999').status_code == 404


def _tile(z: int, lon: float, lat: float) -> tuple[int, int, int]:
    """O tile z/x/y (esquema XYZ) que contém o ponto."""
    m = 2 ** z
    r = math.radians(lat)
    return z, int((lon + 180) / 360 * m), int((1 - math.asinh(math.tan(r)) / math.pi) / 2 * m)


def test_tiles_do_car_levam_o_id_e_nao_o_codigo(api, cod):
    ativo = api.post('/car/resumo', json={'cods': [cod['ativo_sem_alerta']]}).json()[0]
    with pool.connection() as con:
        tile = bytes(con.execute('SELECT ref.car_tiles(%s, %s, %s) AS t', _tile(14, *ativo['centro'])).fetchone()['t'])
    assert b'status' in tile and cod['ativo_sem_alerta'].encode() not in tile


def test_ficha_traz_o_contorno(api, cod):
    contorno = api.get(f'/car/{cod["ativo_sem_alerta"]}').json()['contorno']
    # A simplificação devolve Polygon quando o imóvel tem uma parte só.
    anel = contorno['coordinates'][0] if contorno['type'] == 'Polygon' else contorno['coordinates'][0][0]
    assert contorno['type'] in ('Polygon', 'MultiPolygon') and len(anel) >= 4


def test_regras_trazem_a_tabela_da_situacao_do_car(api):
    r = api.get('/analises/regras').json()
    assert r['corte_eudr'] == '2020-12-31' and r['area_min_alerta_ha'] == 1.0
    assert {s['codigo']: s['status'] for s in r['situacoes_car']} == {
        'AT': 'conforme', 'PE': 'atencao', 'SU': 'nao_conforme', 'CA': 'nao_conforme'}
    assert r['car_fora_da_carga']['status'] == 'atencao'
    assert r['tipos_car']['IRU'] == 'Rural property'
