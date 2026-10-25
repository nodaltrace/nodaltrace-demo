"""Motor de elegibilidade do RenovaBio (Resolução ANP 984/2025) sobre os imóveis do CAR.

As regras vêm de `regras/renovabio.yaml`: datas de corte, situações aceitas do CAR, aplicabilidade e isenções. Aqui fica
a lógica de cada regra de imóvel, pelo id, e a leitura das evidências que o NodalTrace tem: a situação do imóvel no SICAR
e os alertas do MapBiomas. O resultado é uma triagem: a prova de que não houve supressão é o laudo assinado que o informe
exige, e análise só automática não é aceita.

O imóvel do CAR é sempre nacional, e o NodalTrace não sabe se a biomassa é residual: as regras valem como para biomassa
não residual de produtor nacional. Os níveis de produtor e de unidade industrial do YAML dependem de dados que o app não
tem (CPF/CNPJ, perfil agrícola, volumes) e não são avaliados.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from functools import cache
from pathlib import Path

import yaml

from ..formato import data as _d, ha as _ha, mes as _mes
from .conformidade import Status, pior, rotulo_situacao

ARQUIVO = Path(__file__).resolve().parents[1] / 'regras' / 'renovabio.yaml'

#: Situação do SICAR → enumeração do YAML.
SITUACAO_SICAR = {'AT': 'ATIVO', 'PE': 'PENDENTE', 'SU': 'SUSPENSO', 'CA': 'CANCELADO'}
NOME_REGRA = {'RB-01': 'No native vegetation clearing', 'RB-02': 'CAR active or pending'}

#: Primeiras detecções do MapBiomas Alerta: o que vem antes não tem triagem automática.
COBERTURA_MAPBIOMAS = date(2019, 1, 1)
#: O YAML não fixa área mínima, mas a remoção de árvores isoladas não é supressão. Mesmo limite do critério EUDR:
#: abaixo dele o alerta pode ser árvore isolada ou ruído de borda e vai para revisão.
AREA_MIN_SUPRESSAO_HA = 1.0


def _plural(n: int, um: str, varios: str) -> str:
    return f'{n} {um if n == 1 else varios}'


# --- conjunto de regras --------------------------------------------------------------------------

@dataclass(frozen=True)
class Regras:
    dados: dict
    #: SHA-256 do arquivo: identifica exatamente as regras aplicadas num relatório.
    hash: str

    @property
    def meta(self) -> dict:
        return self.dados['meta']

    @property
    def versao(self) -> str:
        return str(self.meta.get('version', ''))

    @property
    def minuta(self) -> bool:
        return self.meta.get('status') == 'draft'

    @property
    def rotulo(self) -> str:
        return f'RenovaBio rules v{self.versao}{" (draft)" if self.minuta else ""}, SHA-256 {self.hash[:12]}'

    def regra(self, rid: str) -> dict:
        return next(r for r in self.dados['rules'] if r['id'] == rid)

    @property
    def corte_eudr(self) -> date:
        return next(d['eudr'] for d in self.dados['eudr_delta']['differences'] if d['topic'] == 'cutoff_date')


@cache
def regras() -> Regras:
    texto = ARQUIVO.read_bytes()
    return Regras(yaml.safe_load(texto), hashlib.sha256(texto).hexdigest())


def publicacao(r: Regras | None = None) -> dict:
    """Versão, hash e fontes do arquivo de regras, com as ressalvas do YAML, e o conteúdo dele, para auditoria
    (GET /renovabio/regras)."""
    r = r or regras()
    fontes = r.meta.get('sources', {})
    return {
        'regime': r.meta['regime'], 'versao': r.versao, 'minuta': r.minuta, 'hash': r.hash, 'rotulo': r.rotulo,
        'ato_normativo': fontes.get('governing_act'), 'detalhe_operacional': fontes.get('operational_detail'),
        'referencias_verificadas': bool(fontes.get('legal_refs_verified')),
        'conteudo': r.dados,
    }


# --- imóvel --------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Imovel:
    """O que o motor precisa de um imóvel do CAR. `situacao` é o código do SICAR (AT, PE, SU, CA)."""

    cod_imovel: str
    situacao: str
    vigente: bool
    uf: str


@dataclass(frozen=True)
class Bases:
    #: Detecção mais recente da camada vigente do MapBiomas, até onde a base vai (None: não carregado).
    mapbiomas: date | None
    #: Por UF, a atualização mais recente de um imóvel na carga vigente do SICAR.
    sicar: dict[str, date] = field(default_factory=dict)


@dataclass
class ResultadoRegra:
    id: str
    nome: str
    #: None: a regra não se aplica ao imóvel.
    status: Status | None
    resumo: str
    detalhes: list[str]
    referencia: str


@dataclass
class Sinal:
    """Cruzamento com a EUDR (X-01 a X-04 do YAML): onde os dois regimes divergem."""

    id: str
    titulo: str
    texto: str


@dataclass
class Avaliacao:
    cod_imovel: str
    #: conforme = elegível; nao_conforme = inelegível; atencao = revisar; pendente = falta base.
    status: Status
    regras: list[ResultadoRegra]
    sinais: list[Sinal]

    @property
    def resultado(self) -> str | None:
        """O desfecho do YAML (ELIGIBLE/INELIGIBLE); None enquanto houver revisão ou base pendente."""
        return {'conforme': 'ELIGIBLE', 'nao_conforme': 'INELIGIBLE'}.get(self.status)


#: O que o motor sabe do imóvel para as condições `applies_when` do YAML (ver a docstring do módulo).
APLICABILIDADE = {'origin': 'national', 'is_residue': False}


def _nao_aplica(r: Regras, rid: str) -> str | None:
    """Por que a regra não vale para um imóvel do CAR (`applies_when` do YAML), ou None se vale. As isenções do YAML (biomassa
    residual, produtor estrangeiro) nunca se aplicam a um imóvel do CAR sem esses dados."""
    for campo, aceitos in r.regra(rid).get('applies_when', {}).items():
        if campo not in APLICABILIDADE:
            raise ValueError(f'Condição {campo} da regra {rid} sem dado no imóvel do CAR')
        if APLICABILIDADE[campo] not in (aceitos if isinstance(aceitos, list) else [aceitos]):
            return {'origin': 'applies only to domestic producers', 'is_residue': 'residue biomass'}[campo]
    return None


def _rb01(regra: dict, im: Imovel, alertas: list[dict], bases: Bases) -> tuple[Status, str, list[str]]:
    corte, janela, ev = regra['cutoff_date'], regra['transitional_window'], regra['evidence']
    depois = lambda x: _d(x) if isinstance(x, date) else 'the end of the base period'  # noqa: E731
    ressalvas = [
        f'Automated screening: the Technical Note requires a technical report signed by the responsible technician, comparing images of up to '
        f'{ev["spatial_resolution_m_max"]} m ({" or ".join(ev["recommended_sensors"])}); automated-only analysis is not accepted',
        'Comparisons in the technical report: ' + '; '.join(f'before {_d(c["before"])} × after {depois(c["after"])}'
                                                            for c in ev['comparisons_required']),
        f'MapBiomas Alerta has detections since {_d(COBERTURA_MAPBIOMAS)}: {_d(corte)} to {_d(COBERTURA_MAPBIOMAS - timedelta(days=1))} '
        f'and the transition window ({_d(janela["from"])} to {_d(janela["to"])}, clearing only with authorization) are left to the '
        'technical report',
        'The rule applies to the area dedicated to energy biomass; the screening covers the whole CAR property',
    ]
    if bases.mapbiomas is None:
        return 'pendente', 'MapBiomas Alerta not loaded: no imagery screening', ressalvas
    carga = f'MapBiomas alert data through {_d(bases.mapbiomas)}'
    pos = [a for a in alertas if a['detectado_em'] > corte]
    if not pos:
        return 'conforme', f'No sign of native vegetation clearing after {_d(corte)} ({carga})', ressalvas
    linhas = [f'Alert #{a["alerta"]}: {_ha(a["area_ha"])} on the property, detected in {_mes(a["detectado_em"])}' for a in pos]
    maior = max(pos, key=lambda a: a['area_ha'])
    texto = (f'{_plural(len(pos), "MapBiomas alert", "MapBiomas alerts")} after {_d(corte)} totaling {_ha(sum(a["area_ha"] for a in pos))} '
             f'on the property · largest: Alert #{maior["alerta"]}, {_ha(maior["area_ha"])}, detected in {_mes(maior["detectado_em"])} · {carga}')
    if maior['area_ha'] >= AREA_MIN_SUPRESSAO_HA:
        return 'nao_conforme', f'{texto}: sign of clearing, property ineligible', linhas + ressalvas
    return 'atencao', f'{texto} · below 1 ha: may be isolated tree removal, which is not clearing; review', linhas + ressalvas


def _rb02(regra: dict, im: Imovel, alertas: list[dict], bases: Bases) -> tuple[Status, str, list[str]]:
    aceitas = [s.strip() for s in re.search(r'in \[(.*)\]', regra['condition']).group(1).split(',')]
    detalhes = []
    if data := bases.sicar.get(im.uf):
        detalhes.append(f'Reference date: Dec 31, {data.year}; the status is the one in SICAR with data through {_d(data)}, to be '
                        'confirmed on that date')
    detalhes += [
        'A CAR regularized during the year makes the whole year\'s biomass eligible; previous years remain ineligible',
        'Proof: SICAR statement with the query date or the date of the last status change, or an official letter from the Brazilian '
        'Forest Service',
    ]
    prova = 'unless there is dated proof that it was active or pending on Dec 31 of the base year'
    if not im.vigente:
        return 'atencao', f'CAR missing from the latest SICAR data load: ineligible, {prova}', detalhes
    situacao = SITUACAO_SICAR.get(im.situacao, im.situacao)
    rotulo = rotulo_situacao(im.situacao).lower()
    if situacao in aceitas:
        if situacao == 'PENDENTE':
            detalhes.insert(0, 'Pending is accepted in RenovaBio; under the EUDR CAR criterion, NodalTrace flags Attention')
        return 'conforme', f'CAR {rotulo} in SICAR: accepted status', detalhes
    return 'nao_conforme', f'CAR {rotulo} in SICAR: property ineligible, {prova}', detalhes


AVALIAR = {'RB-01': _rb01, 'RB-02': _rb02}


def _sinais(r: Regras, resultados: list[ResultadoRegra], alertas: list[dict]) -> list[Sinal]:
    corte_rb, corte_eudr = r.regra('RB-01')['cutoff_date'], r.corte_eudr
    out = []
    rb01 = next(x for x in resultados if x.id == 'RB-01')
    if rb01.status == 'conforme':
        out.append(Sinal('X-01', 'Evidence reusable for the EUDR',
                         'The image comparison in the technical report serves the EUDR deforestation check; '
                         'plot polygons and proof of legality are still missing'))
    entre = [a for a in alertas if corte_rb < a['detectado_em'] <= corte_eudr and a['area_ha'] >= AREA_MIN_SUPRESSAO_HA]
    # Só diverge se o RenovaBio reprova o imóvel por esse alerta e nada depois do corte da EUDR o reprova lá também.
    reprova_eudr = any(a['detectado_em'] > corte_eudr and a['area_ha'] >= AREA_MIN_SUPRESSAO_HA for a in alertas)
    if entre and rb01.status == 'nao_conforme' and not reprova_eudr:
        out.append(Sinal('X-02', 'Ineligible in RenovaBio, possibly compliant under the EUDR',
                         f'{_plural(len(entre), "alert detected", "alerts detected")} between {_d(corte_rb + timedelta(days=1))} and '
                         f'{_d(corte_eudr)}: after the RenovaBio cutoff and before the EUDR cutoff'))
    return out


def avaliar_imovel(im: Imovel, alertas: list[dict], bases: Bases, r: Regras | None = None) -> Avaliacao:
    """Todas as regras do YAML sobre o imóvel. Elegível só se todas as aplicáveis passam."""
    r = r or regras()
    resultados = []
    for regra in r.dados['rules']:
        rid = regra['id']
        nome = NOME_REGRA.get(rid, regra['name'])
        if motivo := _nao_aplica(r, rid):
            resultados.append(ResultadoRegra(rid, nome, None, f'Not applicable: {motivo}', [], regra['legal_ref']))
        elif rid not in AVALIAR:
            resultados.append(ResultadoRegra(rid, nome, 'pendente', 'Rule in the set not yet implemented in the engine', [], regra['legal_ref']))
        else:
            status, resumo, detalhes = AVALIAR[rid](regra, im, alertas, bases)
            resultados.append(ResultadoRegra(rid, nome, status, resumo, detalhes, regra['legal_ref']))
    status: Status = 'conforme'
    for x in resultados:
        if x.status:
            status = pior(status, x.status)
    return Avaliacao(im.cod_imovel, status, resultados, _sinais(r, resultados, alertas))
