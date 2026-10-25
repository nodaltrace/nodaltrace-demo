"""Regras de conformidade sobre os dados reais (api/nodaltrace/dominio/conformidade.py). Puro: sem banco."""

from datetime import date

from nodaltrace import formato as F
from nodaltrace.dominio import conformidade as C

CARGA = date(2026, 10, 8)


def alerta(n: str, detectado: date, area: float) -> dict:
    return {'alerta': n, 'detectado_em': detectado, 'area_ha': area, 'fontes': ['SAD']}


def test_situacao_do_car():
    assert C.situacao_car('AT') == ('conforme', 'CAR active in SICAR')
    assert C.situacao_car('PE')[0] == 'atencao'
    assert C.situacao_car('SU')[0] == 'nao_conforme'
    assert C.situacao_car('CA')[0] == 'nao_conforme'
    # Fora da carga vigente pede revisão, qualquer que seja a última situação conhecida.
    assert C.situacao_car('AT', vigente=False) == C.FORA_DA_CARGA
    assert C.situacao_car(None) == C.SEM_SITUACAO
    assert set(C.SITUACAO_CAR) == set(C.ROTULO_SITUACAO_CAR)


def test_pequena_propriedade():
    assert C.pequena_propriedade(4)
    assert C.pequena_propriedade(0.5)
    assert not C.pequena_propriedade(4.01)
    assert not C.pequena_propriedade(None)


def test_alertas_contra_o_corte_da_eudr():
    assert C.status_alerta(alerta('1', C.CORTE_EUDR, 50)) is None
    assert C.status_alerta(alerta('1', date(2021, 1, 1), 1.0)) == 'nao_conforme'
    assert C.status_alerta(alerta('1', date(2021, 1, 1), 0.99)) == 'atencao'


def test_avaliar_alertas():
    status, texto = C.avaliar_alertas([], CARGA)
    assert status == 'conforme' and 'on the property' in texto and 'Oct 8, 2026' in texto
    assert C.avaliar_alertas([], CARGA, 'area')[1].count('on the area') == 1
    # Só os anteriores ao corte: não contam.
    assert C.avaliar_alertas([alerta('1', date(2019, 5, 1), 30)], CARGA)[0] == 'conforme'
    status, texto = C.avaliar_alertas([alerta('7', date(2023, 4, 2), 2.5), alerta('8', date(2022, 1, 3), 0.4)], CARGA)
    assert status == 'nao_conforme'
    assert texto.startswith('2 MapBiomas alerts after Dec 31, 2020 totaling 2.9 ha on the property · largest: Alert #7, 2.5 ha, '
                            'detected in Apr 2023')
    status, texto = C.avaliar_alertas([alerta('8', date(2022, 1, 3), 0.4)], CARGA)
    assert status == 'atencao' and texto.startswith('1 MapBiomas alert after')
    assert texto.endswith('overlap below 1 ha, may be edge noise: review')


def test_bioma_informativo():
    biomas = C.biomas_em_ingles([{'nome': 'Mata Atlântica', 'fracao': 0.624}, {'nome': 'Pampa', 'fracao': 0.376}])
    assert [b['nome'] for b in biomas] == ['Atlantic Forest', 'Pampa'] and C.biomas_em_ingles(None) is None
    assert C.status_bioma(biomas) is None
    assert C.texto_biomas(biomas) == 'Atlantic Forest 62.4% · Pampa 37.6% of the property'
    assert C.texto_biomas([{'nome': 'Pampa', 'fracao': 1.0}]) == 'Pampa (100% of the property)'
    assert C.texto_biomas([]) == 'Property outside the terrestrial biomes on the IBGE map'


def test_numeros_e_datas_em_ingles():
    assert F.ha(1234.56) == '1,234.6 ha' and F.pct(0.624) == '62.4%' and F.pct_curto(0.999) == '100%'
    assert F.data(date(2020, 12, 31)) == 'Dec 31, 2020' and F.data(None) == 'date not reported' and F.mes(date(2025, 10, 14)) == 'Oct 2025'


def test_pior_status():
    assert C.pior('conforme', 'pendente') == 'pendente'
    assert C.pior('nao_conforme', 'atencao') == 'nao_conforme'
