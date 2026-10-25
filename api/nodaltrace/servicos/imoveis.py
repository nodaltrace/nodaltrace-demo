"""Fichas dos imóveis do CAR: a versão que vale, o histórico e os critérios de conformidade sobre ela."""

from __future__ import annotations

from psycopg import Connection

from ..consultas import alertas, cargas, imoveis
from ..dominio.conformidade import TIPO_CAR, avaliar_alertas, pequena_propriedade, rotulo_situacao, situacao_car, status_alerta
from ..erros import NaoEncontrado


def resumos(con: Connection, cods: list[str]) -> list[dict]:
    """Ficha curta de cada imóvel, com a situação no SICAR lida como critério. Códigos inexistentes ficam de fora."""
    pedidos = list(dict.fromkeys(c.strip().upper() for c in cods if c.strip()))
    return [{**r, 'situacao_rotulo': rotulo_situacao(r['situacao']),
             'conformidade': situacao_car(r['situacao'], r['vigente'])[0]}
            for r in imoveis.que_valem(con, pedidos).values()]


def resumo_da_feicao(con: Connection, feicao: int) -> dict:
    """Ficha curta do imóvel de uma feição dos tiles do CAR: o mapa só leva o id, o código vem daqui."""
    cod = imoveis.cod_da_feicao(con, feicao)
    if cod is None:
        raise NaoEncontrado(f'No current property with feature {feicao}: the map tiles may predate the latest data load')
    return resumos(con, [cod])[0]


def ficha(con: Connection, cod: str) -> dict:
    """A versão que vale do imóvel com os rótulos, o histórico de versões, os alertas do MapBiomas, os biomas e os
    critérios do CAR e da EUDR."""
    versoes = imoveis.versoes(con, cod)
    if not versoes:
        raise NaoEncontrado(f'CAR {cod} not found')
    atual = versoes[0]
    lista = alertas.dos_imoveis(con, [cod])[cod]
    mapbiomas = cargas.camada_vigente(con, 'mapbiomas')
    return {
        **{k: atual[k] for k in ('cod_imovel', 'vigente', 'uf', 'municipio', 'cod_ibge', 'area_ha', 'mod_fiscal', 'situacao', 'tipo',
                                 'condicao', 'criado_sicar', 'atualizado_sicar', 'limites')},
        'pequena_propriedade': pequena_propriedade(atual['mod_fiscal']),
        'situacao_rotulo': rotulo_situacao(atual['situacao']),
        'conformidade_car': dict(zip(('status', 'evidencia'), situacao_car(atual['situacao'], atual['vigente']))),
        'tipo_rotulo': TIPO_CAR.get(atual['tipo'], atual['tipo']),
        'versoes': [{**v, 'conformidade': situacao_car(v['situacao'])[0]} for v in versoes],
        # Critério EUDR do imóvel pelos alertas reais; nulo se o MapBiomas não foi carregado.
        'eudr': dict(zip(('status', 'evidencia'), avaliar_alertas(lista, mapbiomas['dados_ate']))) if mapbiomas else None,
        'alertas': [{**a, 'status': status_alerta(a)} for a in lista],
        'biomas': imoveis.biomas(con, [cod]).get(cod),
        'contorno': imoveis.recorte(con, cod)['contorno'],
    }
