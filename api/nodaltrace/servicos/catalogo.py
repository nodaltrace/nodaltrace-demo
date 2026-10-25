"""Catálogo das análises que podem ser aplicadas a uma seleção de imóveis do CAR.

Cada análise cita a base que usa (com as datas dela) e devolve um resultado por código do CAR. Para incluir uma
análise nova, basta registrá-la em ANALISES: o painel a lista (já marcada) e o relatório a aplica. Uma análise cuja base
não está carregada aparece no catálogo como indisponível. As consultas que mais de uma análise usa (alertas, biomas,
cargas) ficam em `Bases` e `Selecao` e rodam uma vez só por pedido.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from functools import cached_property

from psycopg import Connection

from ..consultas import alertas, cargas, feicoes, imoveis
from ..dominio.conformidade import AREA_MIN_ALERTA_HA, CORTE_EUDR, Status, avaliar_alertas, situacao_car, status_bioma, texto_biomas
from ..dominio.renovabio import Avaliacao, Bases as BasesRenovabio, Imovel, avaliar_imovel, regras
from ..formato import data as _data, dia as _dia, ha as _ha, mes as _mes, pct as _pct


#: Ordem das bases no relatório.
FONTES = ('sicar', 'mapbiomas', 'bioma', 'embargo')


def _datas(b: dict, dados: str) -> str:
    """'updates through Oct 1, 2026, loaded on Oct 9, 2026', com a publicação na fonte quando informada. `dados`:
    o que `dados_ate` mede nesta base."""
    partes = [f'{dados} through {_data(b["dados_ate"])}' if b['dados_ate'] else 'undated data']
    if b['publicado_em']:
        partes.append(f'published on {_data(b["publicado_em"])}')
    partes.append(f'loaded on {_data(_dia(b["carregado_em"]))}')
    return ', '.join(partes)


class Bases:
    """As bases carregadas, lidas uma vez por pedido: o catálogo e o relatório citam as datas de cada uma."""

    def __init__(self, con: Connection):
        self.con = con
        self._camadas: dict[str, dict | None] = {}

    @cached_property
    def car(self) -> list[dict]:
        return cargas.car(self.con)

    @cached_property
    def bioma(self) -> dict | None:
        return cargas.bioma(self.con)

    def camada(self, tipo: str) -> dict | None:
        if tipo not in self._camadas:
            self._camadas[tipo] = cargas.camada_vigente(self.con, tipo)
        return self._camadas[tipo]

    def do_relatorio(self, fontes: set[str], ufs: set[str]) -> list[dict]:
        """As bases que entram no relatório, com as três datas de cada uma: o SICAR das UFs dos imóveis (sempre: os
        imóveis vêm dele) e as das análises escolhidas. Instantes com precisão de segundo, como no resto do documento."""
        out = [{'fonte': 'sicar', 'nome': 'SICAR · Property Area', 'uf': r['uf'], 'versao': None,
                **{k: r[k] for k in ('dados_ate', 'publicado_em', 'carregado_em')}}
               for r in self.car if r['uf'] in ufs]
        for fonte in FONTES[1:]:
            if fonte not in fontes:
                continue
            if fonte == 'bioma':
                c = self.bioma
                out.append({'fonte': 'bioma', 'nome': 'IBGE · Biomes 1:250,000', 'uf': None, 'versao': f'{c["edicao"]} edition',
                            'dados_ate': None, 'publicado_em': None, 'carregado_em': c['carregado_em']})
            else:
                c = self.camada(fonte)
                # A versão do MapBiomas é só a data de referência da carga: as datas já vão nas colunas.
                out.append({'fonte': fonte, 'nome': c['nome'], 'uf': None, 'versao': None if fonte == 'mapbiomas' else c['versao'],
                            **{k: c[k] for k in ('dados_ate', 'publicado_em', 'carregado_em')}})
        return [{**b, 'carregado_em': b['carregado_em'].replace(microsecond=0)} for b in out]


class Selecao:
    """Os imóveis de um relatório (a versão que vale de cada um) e o que as análises consultam sobre eles."""

    def __init__(self, con: Connection, imoveis_: list[dict], bases: Bases):
        self.con, self.imoveis, self.bases = con, imoveis_, bases
        self.cods = [i['cod_imovel'] for i in imoveis_]

    @cached_property
    def alertas(self) -> dict[str, list[dict]]:
        return alertas.dos_imoveis(self.con, self.cods)

    @cached_property
    def biomas(self) -> dict[str, list[dict] | None]:
        return imoveis.biomas(self.con, self.cods)

    @cached_property
    def renovabio(self) -> dict[str, Avaliacao]:
        """Todas as regras do RenovaBio sobre os imóveis (ver dominio/renovabio.py)."""
        mapbiomas = self.bases.camada('mapbiomas')
        bases = BasesRenovabio(mapbiomas['dados_ate'] if mapbiomas else None,
                               {r['uf']: r['dados_ate'] for r in self.bases.car if r['dados_ate']})
        return {i['cod_imovel']: avaliar_imovel(Imovel(i['cod_imovel'], i['situacao'], i['vigente'], i['uf']), self.alertas[i['cod_imovel']], bases)
                for i in self.imoveis}


@dataclass
class Resultado:
    #: None: resultado informativo, não entra no veredito do imóvel.
    status: Status | None
    resumo: str
    detalhes: list[str] = field(default_factory=list)
    #: A evidência em dados (ids, áreas, datas, situação), para quem audita conferir na fonte. Vai para o relatório.
    fatos: dict = field(default_factory=dict)


def _fato_alerta(a: dict) -> dict:
    """Um alerta do MapBiomas como evidência: o id no MapBiomas Alerta, a detecção e as áreas (no imóvel e do alerta)."""
    return {k: a[k] for k in ('alerta', 'detectado_em', 'area_ha', 'area_alerta_ha', 'classe', 'fontes', 'pos_corte')}


@dataclass(frozen=True)
class Analise:
    id: str
    nome: str
    descricao: str
    #: Base usada, com as datas dela (vai para o relatório). None: base não carregada, análise indisponível.
    base: Callable[[Bases], str | None]
    executar: Callable[[Selecao], dict[str, Resultado]]
    #: As bases (FONTES) cujas datas o relatório lista quando a análise entra.
    fontes: tuple[str, ...]


# --- situação no SICAR ---------------------------------------------------------------------------

def _base_car(b: Bases) -> str | None:
    por_uf = '; '.join(f'{r["uf"]}: {_datas(r, "updates")}' for r in b.car)
    return f'SICAR, Property Area theme ({por_uf})' if b.car else None


def _situacao_car(s: Selecao) -> dict[str, Resultado]:
    out = {}
    for i in s.imoveis:
        detalhes = [f'Condition in SICAR: {i["condicao"]}']
        if i['atualizado_sicar']:
            detalhes.append(f'Last updated in SICAR: {_data(i["atualizado_sicar"])}')
        fatos = {k: i[k] for k in ('situacao', 'condicao', 'vigente', 'atualizado_sicar')}
        out[i['cod_imovel']] = Resultado(*situacao_car(i['situacao'], i['vigente']), detalhes, fatos)
    return out


# --- desmatamento depois do corte da EUDR (MapBiomas Alerta) -------------------------------------

def _base_mapbiomas(b: Bases) -> str | None:
    c = b.camada('mapbiomas')
    return f'MapBiomas Alerta ({_datas(c, "alerts detected")}); alert × CAR overlap computed on the loaded CAR version' if c else None


def _desmatamento(s: Selecao) -> dict[str, Resultado]:
    dados_ate = s.bases.camada('mapbiomas')['dados_ate']
    out = {}
    for cod, lista in s.alertas.items():
        status, evidencia = avaliar_alertas(lista, dados_ate)
        pos = [a for a in lista if a['pos_corte']]
        detalhes = [
            f'Alert #{a["alerta"]}: {_ha(a["area_ha"])} on the property, detected in {_mes(a["detectado_em"])} ({", ".join(a["fontes"])})'
            for a in pos
        ]
        if antes := len(lista) - len(pos):
            qtd = '1 alert' if antes == 1 else f'{antes} alerts'
            detalhes.append(f'{qtd} detected on or before {_data(CORTE_EUDR)}: before the cutoff, not counted for the EUDR')
        out[cod] = Resultado(status, evidencia, detalhes, {'alertas': [_fato_alerta(a) for a in lista]})
    return out


# --- bioma (IBGE) --------------------------------------------------------------------------------

def _base_bioma(b: Bases) -> str | None:
    c = b.bioma
    return (f'IBGE, Biomes and Coastal-Marine System of Brazil 1:250,000 ({c["edicao"]} edition, loaded on '
            f'{_data(_dia(c["carregado_em"]))})' if c else None)


def _bioma(s: Selecao) -> dict[str, Resultado]:
    """Bioma de cada imóvel. Informativo enquanto REGRAS_BIOMA (dominio/conformidade.py) não tiver regra."""
    out = {}
    for cod in s.cods:
        biomas = s.biomas.get(cod) or []
        status = status_bioma(biomas)
        resumo = texto_biomas(biomas) + ('' if status else ' · informational, no effect on the status for now')
        out[cod] = Resultado(status, resumo, [f'{b["nome"]}: {_ha(b["area_ha"])} ({_pct(b["fracao"])})' for b in biomas],
                             {'biomas': [{'bioma': b['nome'], 'area_ha': b['area_ha'], 'fracao': b['fracao']} for b in biomas]})
    return out


# --- camadas ambientais genéricas (embargos) -----------------------------------------------------

def _cruzamento(tipo: str, nome: tuple[str, str], base: str, so_pos_corte: bool) -> tuple[Callable, Callable]:
    """Interseção do imóvel com as feições da camada vigente do tipo. Disponível assim que a camada for carregada.
    `nome`: a feição no singular e no plural, em inglês."""
    um, varios = nome

    def _base(b: Bases) -> str | None:
        c = b.camada(tipo)
        return f'{base}, version {c["versao"]} ({_datas(c, "data")})' if c else None

    def _executar(s: Selecao) -> dict[str, Resultado]:
        achados = feicoes.intersecoes(s.con, tipo, s.cods, CORTE_EUDR if so_pos_corte else None)
        out = {}
        for cod in s.cods:
            r = achados.get(cod)
            if not r:
                out[cod] = Resultado('conforme', f'No {varios} on the property', fatos={'n': 0, 'area_ha': 0})
                continue
            texto = f'{r["n"]} {um if r["n"] == 1 else varios} on the property, totaling {_ha(r["area_ha"])}'
            grave = not so_pos_corte or r['area_ha'] >= AREA_MIN_ALERTA_HA
            out[cod] = Resultado('nao_conforme' if grave else 'atencao', texto if grave else f'{texto} · below 1 ha: review',
                                 fatos={'n': r['n'], 'area_ha': r['area_ha']})
        return out

    return _base, _executar


_EMBARGO = _cruzamento('embargo', ('embargoed area', 'embargoed areas'), 'IBAMA embargoed areas', False)


# --- RenovaBio (regras/renovabio.yaml) -----------------------------------------------------------

def _regra_renovabio(rid: str) -> Callable[[Selecao], dict[str, Resultado]]:
    def _executar(s: Selecao) -> dict[str, Resultado]:
        verificadas = regras().meta.get('sources', {}).get('legal_refs_verified', False)
        por_cod = {i['cod_imovel']: i for i in s.imoveis}
        out = {}
        for cod, a in s.renovabio.items():
            x = next(r for r in a.regras if r.id == rid)
            detalhes = list(x.detalhes)
            if rid == 'RB-01':
                detalhes += [f'EUDR cross-check ({sinal.id}): {sinal.titulo}. {sinal.texto}' for sinal in a.sinais]
                fatos = {'corte': _CORTE_RB, 'alertas': [_fato_alerta(al) for al in s.alertas[cod] if al['detectado_em'] > _CORTE_RB],
                         'sinais': [sinal.id for sinal in a.sinais]}
            else:
                fatos = {k: por_cod[cod][k] for k in ('situacao', 'vigente')}
            detalhes.append(f'Reference: {x.referencia}' + ('' if verificadas else ' (unverified)'))
            out[cod] = Resultado(x.status, x.resumo, detalhes, fatos)
        return out

    return _executar


def _base_rb01(b: Bases) -> str | None:
    c = b.camada('mapbiomas')
    return f'{regras().rotulo} · MapBiomas Alerta ({_datas(c, "alerts detected")})' if c else None


def _base_rb02(b: Bases) -> str | None:
    car = _base_car(b)
    return f'{regras().rotulo} · {car}' if car else None


_CORTE_RB = regras().regra('RB-01')['cutoff_date']


ANALISES: list[Analise] = [
    # Demo do hackathon: o banco só tem imóveis ativos, e as descrições do CAR falam só deles (as outras situações distrairiam
    # o jurado). As regras não mudam.
    Analise('situacao_car', 'CAR status', 'Registration status of the property in SICAR: an active CAR is Compliant.',
            _base_car, _situacao_car, ('sicar',)),
    Analise('desmatamento_eudr', 'Deforestation after the EUDR cutoff',
            f'MapBiomas alerts detected after {_data(CORTE_EUDR)} inside the property: 1 ha or more is Non-compliant; below that, review.',
            _base_mapbiomas, _desmatamento, ('mapbiomas',)),
    Analise('bioma', 'Biome (IBGE)', 'IBGE biome(s) the property lies in, with the share of each (informational, no effect on the verdict '
            'yet).',
            _base_bioma, _bioma, ('bioma',)),
    Analise('embargo', 'IBAMA embargoes', 'IBAMA embargoed areas inside the property: any embargo is Non-compliant.', *_EMBARGO,
            ('embargo',)),
    Analise('renovabio_rb01', 'RenovaBio · no native vegetation clearing',
            f'MapBiomas alerts after {_data(_CORTE_RB)} inside the property: 1 ha or more makes the property ineligible; below that, '
            'review. Screening only: the signed technical report is still required. Includes the EUDR cross-check.',
            _base_rb01, _regra_renovabio('RB-01'), ('mapbiomas',)),
    Analise('renovabio_rb02', 'RenovaBio · CAR status', 'CAR status in SICAR: an active CAR meets the requirement.',
            _base_rb02, _regra_renovabio('RB-02'), ('sicar',)),
]

POR_ID = {a.id: a for a in ANALISES}


def catalogo(con: Connection) -> list[dict]:
    """As análises na ordem do catálogo, com a base de cada uma; as indisponíveis dependem de uma base não carregada."""
    b = Bases(con)
    return [{'id': a.id, 'nome': a.nome, 'descricao': a.descricao, 'base': (base := a.base(b)), 'disponivel': base is not None}
            for a in ANALISES]
