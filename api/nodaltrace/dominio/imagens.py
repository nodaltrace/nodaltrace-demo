"""Regras das imagens históricas do imóvel (README, "Imagens históricas"), sem rede: o retângulo e o tamanho do recorte,
as opções de data de cada fonte com os rótulos e créditos, e as datas e o alerta sugeridos para comparar. A busca nas
fontes, o recorte dos COGs e o cache ficam em servicos/imagens.py."""

from __future__ import annotations

import hashlib
import math
import re
from datetime import date

from ..formato import MESES, data

#: Resolução nominal de cada fonte do INPE (m).
RESOLUCAO_M = {'sentinel2': 10, 'cbers4a': 2}
CREDITO_CBERS = 'CBERS-4A/WPM © INPE · CC BY 4.0 · cropped and reprojected'
#: Margem do recorte em volta do retângulo do imóvel, em cada lado (fração da largura e da altura).
MARGEM = 0.15
#: Maior lado do recorte (px).
LADO_MAX = 2048
#: Cobertura mínima para uma data do CBERS entrar na lista.
COBERTURA_MIN = 0.98
#: Ids das opções do INPE: a data de início do trimestre ou a data da cena.
ID_DATA = re.compile(r'\d{4}-\d{2}-\d{2}')
RAIO_TERRA_M = 6378137.0
#: Primeira cena colorida do CBERS-4A no catálogo do INPE: alerta detectado antes disso não tem "antes" nele.
INICIO_CBERS = '2023-03-01'


# --- geometria do recorte -----------------------------------------------------------------------------------------

def limites_do_recorte(oeste: float, sul: float, leste: float, norte: float) -> list[float]:
    dx, dy = (leste - oeste) * MARGEM, (norte - sul) * MARGEM
    return [oeste - dx, sul - dy, leste + dx, norte + dy]


def chave_limites(limites: list[float]) -> str:
    """Identifica o retângulo no nome dos arquivos do cache: muda se a geometria do imóvel mudar."""
    return hashlib.sha256(','.join(f'{x:.7f}' for x in limites).encode()).hexdigest()[:16]


def _y_mercator(lat: float) -> float:
    return RAIO_TERRA_M * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def tamanho(limites: list[float], metros: float, lado_max: int = LADO_MAX) -> tuple[int, int, float]:
    """(largura, altura) em px do recorte em EPSG:3857 com pixels de `metros` no terreno (o maior lado limitado a
    `lado_max`) e a resolução no terreno que resulta. Pixels quadrados no 3857, que é conforme."""
    o, s, l, n = limites
    dx = math.radians(l - o) * RAIO_TERRA_M
    dy = _y_mercator(n) - _y_mercator(s)
    escala = math.cos(math.radians((s + n) / 2))  # metro do 3857 → metro no terreno
    lado_m = max(dx, dy) * escala
    if lado_m <= 0:
        return 1, 1, metros
    lado = max(1, min(lado_max, math.ceil(lado_m / metros)))
    if dx >= dy:
        largura, altura = lado, max(1, round(lado * dy / dx))
    else:
        largura, altura = max(1, round(lado * dx / dy)), lado
    return largura, altura, lado_m / lado


# --- opções de data do INPE ---------------------------------------------------------------------------------------

def _processamento(item: dict) -> tuple[str, str]:
    m = re.search(r'_P(\d{8})', item['id'])
    return (m.group(1) if m else '', item['properties'].get('updated') or '')


def trimestres(itens: list[dict]) -> dict[str, dict]:
    """Sentinel-2: {início do trimestre: item}. Com mais de um item no trimestre, o de processamento mais recente."""
    por: dict[str, dict] = {}
    for it in itens:
        ini = it['properties']['start_datetime'][:10]
        if ini not in por or _processamento(it) > _processamento(por[ini]):
            por[ini] = it
    return dict(sorted(por.items()))


def rotulo_trimestre(inicio: str, fim: str) -> str:
    """'Apr–Jun 2026' (ou 'Dec 2025–Feb 2026' se o período virar o ano)."""
    a, b = date.fromisoformat(inicio[:10]), date.fromisoformat(fim[:10])
    if a.year == b.year:
        return f'{MESES[a.month - 1]}–{MESES[b.month - 1]} {b.year}'
    return f'{MESES[a.month - 1]} {a.year}–{MESES[b.month - 1]} {b.year}'


def opcoes_sentinel2(itens: list[dict]) -> list[dict]:
    return [{'id': ini, 'data': ini, 'rotulo': rotulo_trimestre(ini, it['properties']['end_datetime']), 'cobertura': 1.0}
            for ini, it in trimestres(itens).items()]


def credito_sentinel2(opcoes: list[dict]) -> str:
    anos = sorted({o['data'][:4] for o in opcoes})
    ano = (anos[0] if len(anos) == 1 else f'{anos[0]}–{anos[-1]}') if anos else str(date.today().year)
    return f'Contains modified Copernicus Sentinel data {ano} · INPE/BDC mosaic'


def opcoes_cbers(datas: dict[str, tuple[float, list[dict]]]) -> list[dict]:
    """Uma opção por data com cobertura somada de pelo menos COBERTURA_MIN (`datas` de servicos.imagens.datas_cbers)."""
    return [{'id': d, 'data': d, 'rotulo': data(date.fromisoformat(d)), 'cobertura': round(cob, 3)}
            for d, (cob, _) in datas.items() if cob >= COBERTURA_MIN]


# --- opções do MapBiomas ------------------------------------------------------------------------------------------

def _caixa(texto: str | None) -> list[float] | None:
    """'BOX(o s,l n)' → [o, s, l, n]."""
    m = re.fullmatch(r'\s*BOX\(\s*(\S+)\s+(\S+)\s*,\s*(\S+)\s+(\S+)\s*\)\s*', texto if isinstance(texto, str) else '')
    try:
        return [float(x) for x in m.groups()] if m else None
    except ValueError:
        return None


def opcao_mapbiomas(a: dict, mb: dict | None) -> dict:
    """A opção de um alerta nosso (`alerta`, `detectado_em`) com as imagens de antes e depois que o MapBiomas publicou
    (`mb`, a resposta dele para o alerta; None se não achou)."""
    fotos = {i.get('reference'): {'data': str(i.get('acquiredAt') or '')[:10] or None, 'url': i['url'], 'constelacao': i.get('constellation')}
             for i in (mb or {}).get('publishedImages') or [] if isinstance(i, dict) and isinstance(i.get('url'), str)}
    antes, depois = fotos.get('before'), fotos.get('after')
    tem = bool(antes or depois)
    return {'id': a['alerta'], 'alerta': a['alerta'], 'detectado_em': a['detectado_em'].isoformat(),
            'limites': _caixa(mb.get('alertImageBbox')) if tem else None, 'antes': antes, 'depois': depois}


def credito_mapbiomas(opcoes: list[dict]) -> str:
    constelacoes = sorted({i['constelacao'] for o in opcoes for i in (o['antes'], o['depois']) if i and i['constelacao']})
    texto = ('MapBiomas Alerta – High-Resolution Deforestation Alert Validation and Refinement System. '
             f'Accessed on {date.today().isoformat()} by https://alerta.mapbiomas.org')
    return f'{texto} · images {", ".join(constelacoes)}' if constelacoes else texto


# --- datas e alerta sugeridos para comparar -----------------------------------------------------------------------

def _fim_do_trimestre(data: str) -> str:
    """O mosaico do Sentinel-2 que começa em `data` cobre até a véspera disto (mais um trimestre)."""
    a, m = int(data[:4]), int(data[5:7])
    a, m = (a + 1, m - 9) if m + 3 > 12 else (a, m + 3)
    return f'{a}-{m:02d}-01'


def par_que_cerca(opcoes: list[dict], deteccao: str, trimestral: bool) -> dict | None:
    """Par de datas que cerca uma detecção: antes, a última imagem que termina antes dela; depois, a primeira que começa
    nela ou depois. O trimestre da detecção, no Sentinel-2, não serve de nenhum dos dois lados (pode ter dias de antes e de
    depois); no CBERS-4A, a cena do dia da detecção já é a de depois. Nulo se faltar um dos lados."""
    antes = [o for o in opcoes if (_fim_do_trimestre(o['data']) <= deteccao if trimestral else o['data'] < deteccao)]
    depois = next((o for o in opcoes if o['data'] >= deteccao), None)
    return {'antes': antes[-1]['id'], 'depois': depois['id']} if antes and depois else None


def pares_padrao(opcoes: list[dict], deteccoes: list[str], trimestral: bool) -> dict | None:
    """Datas sugeridas: cerca a detecção mais recente que tem imagem dos dois lados; sem nenhuma (ou sem alerta), a imagem
    mais antiga e a mais recente. `opcoes` vêm da mais antiga para a mais recente."""
    if not opcoes:
        return None
    for d in sorted(deteccoes, reverse=True):
        if par := par_que_cerca(opcoes, d, trimestral):
            return par
    return {'antes': opcoes[0]['id'], 'depois': opcoes[-1]['id']}


def caso_mapbiomas(o: dict) -> str:
    """Como o alerta pode ser comparado: no mapa (imagem com os cantos), sem mapa (imagem sem posição: o alerta está fora
    da base de imóveis do MapBiomas) ou não pode (o MapBiomas não publicou imagem dele)."""
    if not o['antes'] and not o['depois']:
        return 'sem-imagem'
    return 'mapa' if o['limites'] else 'sem-mapa'


def alerta_padrao(opcoes: list[dict]) -> str | None:
    """Alerta sugerido: o mais recente com imagem no mapa, depois o mais recente com imagem sem mapa, depois o mais recente."""
    recentes = opcoes[::-1]
    for caso in ('mapa', 'sem-mapa'):
        if achado := next((o for o in recentes if caso_mapbiomas(o) == caso), None):
            return achado['id']
    return recentes[0]['id'] if recentes else None


def fontes_da_deteccao(detectado_em: str) -> list[str]:
    """Fontes do INPE que podem ter imagem dos dois lados de uma detecção: o Sentinel-2 sempre; o CBERS-4A só de
    março de 2023 em diante."""
    return ['sentinel2', 'cbers4a'] if detectado_em >= INICIO_CBERS else ['sentinel2']
