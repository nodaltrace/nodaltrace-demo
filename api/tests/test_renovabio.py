"""Regras do RenovaBio por imóvel do CAR (api/nodaltrace/dominio/renovabio.py) e o endpoint do conjunto de regras."""

from datetime import date

from nodaltrace.dominio.renovabio import Bases, Imovel, avaliar_imovel, regras


def _rb(alertas=(), bases=Bases(date(2026, 10, 1), {'RS': date(2026, 10, 1)}), **kw):
    im = Imovel(**{'cod_imovel': 'RS-1', 'situacao': 'AT', 'vigente': True, 'uf': 'RS', **kw})
    a = avaliar_imovel(im, list(alertas), bases)
    return a, {x.id: x.status for x in a.regras}, {s.id for s in a.sinais}


def _alerta(ha, detectado):
    return {'alerta': '1', 'area_ha': ha, 'detectado_em': detectado, 'fontes': ['SAD']}


def test_regras_por_imovel():
    a, r, s = _rb()
    assert a.status == 'conforme' and a.resultado == 'ELIGIBLE' and r == {'RB-01': 'conforme', 'RB-02': 'conforme'} and s == {'X-01'}
    # Alerta entre os dois cortes: inelegível no RenovaBio, fora do corte da EUDR.
    a, r, s = _rb(alertas=[_alerta(5, date(2019, 6, 1))])
    assert a.resultado == 'INELIGIBLE' and r['RB-01'] == 'nao_conforme' and s == {'X-02'}
    assert _rb(alertas=[_alerta(0.4, date(2023, 3, 1))])[1]['RB-01'] == 'atencao'      # pode ser árvore isolada
    assert _rb(alertas=[_alerta(9, date(2018, 6, 1))])[1]['RB-01'] == 'conforme'       # antes do corte de 27/11/2018
    # CAR: pendente é aceito no RenovaBio (na EUDR, atenção); suspenso e cancelado reprovam; fora do SICAR pede prova.
    for situacao, esperado in (('PE', 'conforme'), ('SU', 'nao_conforme'), ('CA', 'nao_conforme')):
        assert _rb(situacao=situacao)[1]['RB-02'] == esperado, situacao
    assert _rb(vigente=False)[1]['RB-02'] == 'atencao'
    # Sem o MapBiomas não há triagem.
    assert _rb(bases=Bases(None, {}))[1]['RB-01'] == 'pendente'
    # X-02 só quando o RenovaBio reprova e a EUDR pode passar: alerta depois de 2020 reprova nos dois.
    assert 'X-02' not in _rb(alertas=[_alerta(5, date(2019, 6, 1)), _alerta(5, date(2023, 1, 1))])[2]
    assert 'X-02' in _rb(alertas=[_alerta(5, date(2019, 6, 1)), _alerta(0.3, date(2023, 1, 1))])[2]


def test_endpoint_do_conjunto_de_regras(api):
    r = api.get('/renovabio/regras').json()
    assert r['hash'] == regras().hash and r['versao'] and {x['id'] for x in r['conteudo']['rules']} == {'RB-01', 'RB-02'}
