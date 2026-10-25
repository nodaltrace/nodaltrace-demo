"""Regras de conformidade sobre os dados reais: a situação do imóvel no SICAR, os alertas do MapBiomas contra o corte da
EUDR e o bioma do IBGE. Puro: sem banco. Endpoints, catálogo de análises e relatórios usam só estas funções; o frontend
recebe o resultado (status, evidência, rótulos), nunca a regra."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date
from typing import Literal

from ..formato import data, ha, mes, pct_curto

Status = Literal['conforme', 'atencao', 'pendente', 'nao_conforme']

#: Versão das regras de decisão: este módulo, dominio/renovabio.py com regras/renovabio.yaml e a lógica das análises de
#: servicos/catalogo.py. Vai no cabeçalho de cada relatório e no registro dele na Solana. Mudou um parâmetro ou a lógica
#: de uma decisão: versão nova, registrada em regras/versoes.json (tests/test_regras.py confere os parâmetros; a lógica,
#: só a revisão).
VERSAO_REGRAS = '2026.1'

#: Gravidade de cada status: o pior de uma lista é o de maior gravidade.
GRAVIDADE: dict[str, int] = {'conforme': 0, 'pendente': 1, 'atencao': 2, 'nao_conforme': 3}


def pior(a: Status, b: Status) -> Status:
    return b if GRAVIDADE[b] > GRAVIDADE[a] else a


def veredito(status: Iterable[Status | None]) -> Status:
    """O pior dos status que emitem veredito (None é informativo e fica de fora); sem nenhum, pendente."""
    avaliados = [s for s in status if s]
    return max(avaliados, key=GRAVIDADE.__getitem__) if avaliados else 'pendente'


# --- situação do imóvel no SICAR -----------------------------------------------------------------

ROTULO_SITUACAO_CAR = {'AT': 'Active', 'PE': 'Pending', 'SU': 'Suspended', 'CA': 'Cancelled'}
TIPO_CAR = {'IRU': 'Rural property', 'AST': 'Settlement', 'PCT': 'Traditional peoples and communities'}

#: Situação do CAR (código do SICAR) como critério: pendente pede atenção; suspenso ou cancelado reprova.
SITUACAO_CAR: dict[str, tuple[Status, str]] = {
    'AT': ('conforme', 'CAR active in SICAR'),
    'PE': ('atencao', 'CAR pending in SICAR'),
    'SU': ('nao_conforme', 'CAR suspended in SICAR'),
    'CA': ('nao_conforme', 'CAR cancelled in SICAR'),
}
#: Imóvel que saiu da carga vigente do SICAR (vale a última versão conhecida): pede revisão.
FORA_DA_CARGA: tuple[Status, str] = ('atencao', 'CAR missing from the latest SICAR data load')
SEM_SITUACAO: tuple[Status, str] = ('pendente', 'CAR status not reported by SICAR')


def rotulo_situacao(situacao: str | None) -> str:
    """'AT' → 'Active'; código desconhecido fica como veio."""
    return ROTULO_SITUACAO_CAR.get(situacao, situacao) if situacao else 'Not reported'


def situacao_car(situacao: str | None, vigente: bool = True) -> tuple[Status, str]:
    """Status e evidência da situação do imóvel no SICAR. `vigente`: o imóvel está na carga mais recente da UF."""
    if not vigente:
        return FORA_DA_CARGA
    return SITUACAO_CAR.get(situacao or '', SEM_SITUACAO)


#: Pequena propriedade ou posse rural familiar: até 4 módulos fiscais (Lei 12.651/2012, art. 3º, V).
MODULOS_PEQUENA_PROPRIEDADE = 4


def pequena_propriedade(mod_fiscal: float | None) -> bool:
    return mod_fiscal is not None and mod_fiscal <= MODULOS_PEQUENA_PROPRIEDADE


# --- alertas do MapBiomas e o corte da EUDR ------------------------------------------------------

#: Data de corte da EUDR: desmatamento depois dela torna a origem não conforme.
CORTE_EUDR = date(2020, 12, 31)
#: Interseção mínima (ha) para um alerta reprovar o imóvel. Abaixo disso pode ser ruído de borda: vai para revisão.
AREA_MIN_ALERTA_HA = 1.0


def status_alerta(a: dict) -> Status | None:
    """Peso de um alerta (`detectado_em`, `area_ha` da interseção) no critério EUDR. Detectado até o corte, não conta."""
    if a['detectado_em'] <= CORTE_EUDR:
        return None
    return 'nao_conforme' if a['area_ha'] >= AREA_MIN_ALERTA_HA else 'atencao'


def avaliar_alertas(alertas: list[dict], dados_ate: date | None, onde: str = 'property') -> tuple[Status, str]:
    """Critério EUDR de um imóvel (ou de uma área) a partir dos alertas do MapBiomas que o atingem. Só contam os
    detectados depois do corte; interseção abaixo do mínimo pede revisão em vez de reprovar. `dados_ate`: a detecção
    mais recente da camada carregada (até onde a base vai), citada na evidência. `onde`: o que a evidência cita, em
    inglês ('property', 'area')."""
    carga = f'alert data through {data(dados_ate)}' if dados_ate else 'undated alert data'
    pos = [a for a in alertas if status_alerta(a)]
    if not pos:
        return 'conforme', f'No MapBiomas alerts detected after {data(CORTE_EUDR)} on the {onde} ({carga})'
    maior = max(pos, key=lambda a: a['area_ha'])
    total = sum(a['area_ha'] for a in pos)
    qtd = '1 MapBiomas alert' if len(pos) == 1 else f'{len(pos)} MapBiomas alerts'
    texto = (f'{qtd} after {data(CORTE_EUDR)} totaling {ha(total)} on the {onde} · largest: Alert #{maior["alerta"]}, '
             f'{ha(maior["area_ha"])}, detected in {mes(maior["detectado_em"])} ({", ".join(maior["fontes"])}) · {carga}')
    if status_alerta(maior) == 'nao_conforme':
        return 'nao_conforme', texto
    return 'atencao', f'{texto} · overlap below {AREA_MIN_ALERTA_HA:g} ha, may be edge noise: review'


# --- bioma do IBGE -------------------------------------------------------------------------------

#: Nome em inglês de cada bioma do IBGE (o banco guarda em português): a API serve só o nome em inglês
#: (consultas/imoveis.biomas), nas fichas, nos textos e nos relatórios.
NOME_BIOMA = {'Amazônia': 'Amazon', 'Caatinga': 'Caatinga', 'Cerrado': 'Cerrado', 'Mata Atlântica': 'Atlantic Forest',
              'Pampa': 'Pampa', 'Pantanal': 'Pantanal', 'Sistema Costeiro-Marinho': 'Coastal-Marine System'}

#: Efeito de cada bioma no compliance, pelo nome em inglês (NOME_BIOMA). Por enquanto nenhum: o bioma é informativo.
#: Uma regra futura entra aqui (por exemplo, 'Amazon': 'atencao'), e a análise passa a ter status sem mudar mais nada.
REGRAS_BIOMA: dict[str, Status | None] = {}


def biomas_em_ingles(biomas: list[dict] | None) -> list[dict] | None:
    """Os biomas de um imóvel (ref.car_resumo.biomas) com o nome em inglês; nome desconhecido fica como veio."""
    return None if biomas is None else [{**b, 'nome': NOME_BIOMA.get(b['nome'], b['nome'])} for b in biomas]


def status_bioma(biomas: list[dict]) -> Status | None:
    """Pior efeito entre os biomas do imóvel pelas REGRAS_BIOMA; None enquanto não houver regra."""
    efeitos = [REGRAS_BIOMA[b['nome']] for b in biomas if REGRAS_BIOMA.get(b['nome'])]
    return max(efeitos, key=GRAVIDADE.__getitem__) if efeitos else None


def texto_biomas(biomas: list[dict]) -> str:
    """'Pampa (100% of the property)' ou 'Atlantic Forest 62.4% · Pampa 37.6% of the property'."""
    if not biomas:
        return 'Property outside the terrestrial biomes on the IBGE map'
    if len(biomas) == 1:
        return f'{biomas[0]["nome"]} ({pct_curto(biomas[0]["fracao"])} of the property)'
    return ' · '.join(f'{b["nome"]} {pct_curto(b["fracao"])}' for b in biomas) + ' of the property'


# --- regras em vigor -----------------------------------------------------------------------------------------------

def regras_em_vigor() -> dict:
    """Os parâmetros acima, para o painel mostrar o que vale e o mapa pintar os imóveis pela situação no SICAR, sem regra
    própria (GET /analises/regras)."""
    return {
        'corte_eudr': CORTE_EUDR,
        'area_min_alerta_ha': AREA_MIN_ALERTA_HA,
        'biomas': {'regras': REGRAS_BIOMA, 'efeito': 'active rules' if any(REGRAS_BIOMA.values()) else 'informational'},
        'situacoes_car': [{'codigo': c, 'rotulo': ROTULO_SITUACAO_CAR[c], 'status': s, 'evidencia': e} for c, (s, e) in SITUACAO_CAR.items()],
        'car_fora_da_carga': {'status': FORA_DA_CARGA[0], 'evidencia': FORA_DA_CARGA[1]},
        'tipos_car': TIPO_CAR,
    }
