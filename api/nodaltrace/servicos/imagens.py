"""Fontes das imagens históricas do imóvel do CAR (README, "Imagens históricas"): mosaicos trimestrais do Sentinel-2 e
cenas do CBERS-4A do INPE/BDC, recortados aqui (os COGs do INPE não liberam CORS), e as imagens antes/depois dos alertas
do MapBiomas, que o navegador carrega direto. Com `NT_IMAGENS_DIR`, cada recorte vai ao INPE uma vez só. As regras sem
rede (recorte, opções, sugestões) ficam em dominio/imagens.py."""

from __future__ import annotations

import base64
import http.client
import json
import logging
import math
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import date
from functools import cache
from pathlib import Path
from typing import Callable, Literal

import numpy as np
import rasterio
from rasterio.errors import RasterioIOError
from rio_tiler.constants import WEB_MERCATOR_CRS, WGS84_CRS
from rio_tiler.errors import EmptyMosaicError
from rio_tiler.io import Reader
from rio_tiler.models import ImageData
from rio_tiler.mosaic import mosaic_reader
from rio_tiler.mosaic.methods.defaults import FirstMethod

from ..dominio.imagens import (COBERTURA_MIN, CREDITO_CBERS, ID_DATA, RESOLUCAO_M, alerta_padrao, caso_mapbiomas, chave_limites,
                               credito_mapbiomas, credito_sentinel2, fontes_da_deteccao, limites_do_recorte, opcao_mapbiomas,
                               opcoes_cbers, opcoes_sentinel2, par_que_cerca, pares_padrao, tamanho, trimestres)
from ..erros import FonteIndisponivel, NaoEncontrado

log = logging.getLogger(__name__)

Fonte = Literal['sentinel2', 'cbers4a', 'mapbiomas']
FonteInpe = Literal['sentinel2', 'cbers4a']

STAC = 'https://data.inpe.br/bdc/stac/v1'
COLECAO = {'sentinel2': 'mosaic-s2-brazil-3m-1', 'cbers4a': 'CB4A-WPM-PCA-FUSED-1'}
ASSET = {'sentinel2': 'visual', 'cbers4a': 'tci'}
MAPBIOMAS = 'https://plataforma.alerta.mapbiomas.org/api/v2/graphql'

#: Lado da overview lida para medir a cobertura de uma cena do CBERS (px).
LADO_COBERTURA = 64
#: Sentinel-2 com tile corrompido: fatores de redução tentados (20, 40 e 80 m). A de 20 m é sempre tentada; as
#: seguintes, só se o lado maior ainda tiver LADO_MIN_REDUZIDO px.
REDUCOES = (2, 4, 8)
LADO_MIN_REDUZIDO = 16
#: Busca STAC e respostas do MapBiomas guardadas em memória (a API roda com um worker só).
VALIDADE_S = 3600
#: Uma falha também fica guardada, por pouco tempo: quem espera o mesmo dado não repete a mesma espera em fila.
VALIDADE_FALHA_S = 30
#: Cena do CBERS cuja cobertura não leu (ou que ficou sem ler porque o INPE caiu): só tentada de novo depois disto,
#: para não segurar cada pedido do imóvel nem insistir com o INPE fora.
ESPERA_CENA_FALHA_S = 120
#: Retângulos com cobertura do CBERS guardada em memória (o arquivo em NT_IMAGENS_DIR guarda todos).
COBERTURAS_MAX = 2000
TIMEOUT_S = 30
LEITURAS_PARALELAS = 8
#: Reserva do MapBiomas (alertas nossos que o `ruralProperty` do imóvel não traz): teto por pedido e paralelismo.
RESERVA_MAX = 20
RESERVA_PARALELAS = 4
#: Meia-largura da caixa do `pointInformation` (°): com 0,002° ele já devolve lista vazia.
RESERVA_MEIA_CAIXA = 0.0005
#: Códigos de `carCodes` tentados por alerta, no passo 3 da reserva.
RESERVA_CODIGOS = 5
#: Sem prazo, o GDAL espera o INPE para sempre e prende a thread do pedido.
#: Prazos curtos e uma nova tentativa só: a abertura e a leitura fazem vários pedidos, e cada um soma o prazo inteiro.
GDAL = {'GDAL_DISABLE_READDIR_ON_OPEN': 'EMPTY_DIR', 'CPL_VSIL_CURL_ALLOWED_EXTENSIONS': '.tif', 'GDAL_HTTP_TIMEOUT': '15',
        'GDAL_HTTP_CONNECTTIMEOUT': '5', 'GDAL_HTTP_MAX_RETRY': '1', 'GDAL_HTTP_RETRY_DELAY': '1'}
#: Só estes endereços são seguidos: os links e os arquivos vêm de respostas do STAC.
ORIGEM_INPE = 'https://data.inpe.br/'

CONSULTA_IMOVEL = """query($c: String) { ruralProperty(propertyCode: $c) { alerts {
  alertCode detectedAt alertImageBbox publishedImages { reference acquiredAt constellation url } } } }"""
CONSULTA_PONTO = """query($b: BoundingBoxInput) { pointInformation(boundingBox: $b) { alerts {
  alertCode carCodes publishedImages { reference acquiredAt constellation url } } } }"""


class ErroFonte(FonteIndisponivel):
    """O INPE ou o MapBiomas não respondeu como esperado: vira 502 com a mensagem em `detail`."""


# --- memória ----------------------------------------------------------------------------------------------------

#: {chave: (instante, valor, falhou)}.
_memo: dict[tuple, tuple[float, object, bool]] = {}
_trava_memo = threading.Lock()
#: {chave: [trava, quantos a usam]}: sai quando ninguém mais usa, então não cresce.
_travas: dict[tuple, list] = {}


@contextmanager
def _exclusivo(chave: tuple):
    """Dois pedidos iguais ao mesmo tempo fazem o trabalho uma vez só (respeitar o INPE); chaves diferentes não se
    esperam."""
    with _trava_memo:
        par = _travas.setdefault(chave, [threading.Lock(), 0])
        par[1] += 1
    try:
        with par[0]:
            yield
    finally:
        with _trava_memo:
            par[1] -= 1
            if par[1] == 0:
                del _travas[chave]


def _lembrar(chave: tuple, fn: Callable[[], object]):
    """Valor guardado por VALIDADE_S. Falha (ErroFonte) guardada por VALIDADE_FALHA_S: quem chega junto recebe a
    mesma falha em vez de esperar outra. Gravar descarta as entradas vencidas."""
    with _exclusivo(chave):
        with _trava_memo:
            achado = _memo.get(chave)
        if achado and time.monotonic() - achado[0] < (VALIDADE_FALHA_S if achado[2] else VALIDADE_S):
            if achado[2]:
                raise achado[1]
            return achado[1]
        try:
            valor, falhou = fn(), False
        except ErroFonte as e:
            valor, falhou = e, True
        agora = time.monotonic()
        with _trava_memo:
            for k in [k for k, (t, _, f) in _memo.items() if agora - t >= (VALIDADE_FALHA_S if f else VALIDADE_S)]:
                del _memo[k]
            _memo[chave] = (agora, valor, falhou)
        if falhou:
            raise valor
        return valor


def _http_json(url: str, corpo: dict | None = None) -> dict:
    dados = json.dumps(corpo).encode() if corpo is not None else None
    req = urllib.request.Request(url, data=dados, headers={'Content-Type': 'application/json', 'Accept': 'application/json'})
    onde = urllib.parse.urlsplit(url).netloc
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            d = json.load(r)
    # O urllib só embrulha em URLError os erros do envio: conexão fechada e corpo cortado chegam como OSError e
    # http.client.HTTPException.
    except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError) as e:
        raise ErroFonte(f'{onde} did not respond ({e})') from e
    if not isinstance(d, dict):
        raise ErroFonte(f'{onde} responded in an unexpected format')
    return d


# --- leitura dos COGs -------------------------------------------------------------------------------------------

def _ler_parte(href: str, limites: list[float], largura: int, altura: int) -> ImageData:
    """Recorte de um COG em EPSG:3857, no tamanho dado (o GDAL escolhe a overview). Cada chamada abre o próprio
    `rasterio.Env` e o próprio dataset: pode rodar em threads."""
    with rasterio.Env(**GDAL), Reader(href) as src:
        return src.part(limites, dst_crs=WEB_MERCATOR_CRS, bounds_crs=WGS84_CRS, width=largura, height=altura)


def _mascara(href: str, limites: list[float]) -> np.ndarray:
    """Onde a cena tem dado no retângulo, numa grade de LADO_COBERTURA px (a mesma para todas as cenas)."""
    largura, altura, _ = tamanho(limites, 1, LADO_COBERTURA)
    return _ler_parte(href, limites, largura, altura).mask > 0


@cache
def formato() -> tuple[str, str, str]:
    """(driver do GDAL, extensão, tipo MIME): WebP com transparência; JPEG se o wheel do rasterio vier sem WebP."""
    with rasterio.Env() as env:
        if 'WEBP' in env.drivers():
            return 'WEBP', 'webp', 'image/webp'
    log.warning('GDAL sem o driver WEBP: imagens históricas em JPEG')
    return 'JPEG', 'jpg', 'image/jpeg'


def _render(img: ImageData) -> bytes:
    driver = formato()[0]
    return img.render(img_format=driver, add_mask=driver == 'WEBP')


# --- STAC do INPE -----------------------------------------------------------------------------------------------

def _item_valido(it, fonte: FonteInpe) -> bool:
    """Item com o que a API usa: id, datas e o arquivo no INPE (nada de caminho local nem outro servidor)."""
    try:
        p, href = it['properties'], it['assets'][ASSET[fonte]]['href']
        datas = (p['start_datetime'], p['end_datetime']) if fonte == 'sentinel2' else (p['datetime'],)
        return isinstance(it['id'], str) and all(ID_DATA.match(d or '') for d in datas) and href.startswith(ORIGEM_INPE)
    except (KeyError, TypeError, AttributeError):
        return False


def buscar_stac(fonte: FonteInpe, limites: list[float]) -> list[dict]:
    """Itens da coleção que tocam o retângulo (seguindo as páginas, se houver). Item malformado fica de fora."""
    def busca() -> list[dict]:
        url, corpo, itens = f'{STAC}/search', {'collections': [COLECAO[fonte]], 'bbox': limites, 'limit': 500}, []
        for _ in range(20):
            d = _http_json(url, corpo)
            itens += [it for it in d.get('features') or [] if _item_valido(it, fonte)]
            prox = next((l for l in d.get('links') or [] if isinstance(l, dict) and l.get('rel') == 'next'), None)
            if not prox:
                return itens
            if not str(prox.get('href', '')).startswith(ORIGEM_INPE):
                raise ErroFonte('data.inpe.br redirected to another address')
            url, corpo = prox['href'], prox.get('body') if (prox.get('method') or 'GET').upper() == 'POST' else None
        return itens
    return _lembrar(('stac', fonte, tuple(limites)), busca)


def _href(item: dict, fonte: FonteInpe) -> str:
    return item['assets'][ASSET[fonte]]['href']


# --- cobertura do CBERS-4A ----------------------------------------------------------------------------------------

#: {chave dos limites: {id da cena: (cobertura, máscara se parcial)}}. Não muda: a cena e o retângulo são fixos.
_coberturas: dict[str, dict[str, tuple[float, np.ndarray | None]]] = {}


def _arquivo_cobertura(cod: str, chave: str) -> Path | None:
    pasta = os.environ.get('NT_IMAGENS_DIR')
    return Path(pasta) / 'cbers4a' / 'cobertura' / f'{_seguro(cod)}_{chave}.json' if pasta else None


def _codificar(m: np.ndarray) -> str:
    return base64.b64encode(np.packbits(m)).decode()


def _decodificar(texto: str, forma: tuple[int, int]) -> np.ndarray:
    bits = np.unpackbits(np.frombuffer(base64.b64decode(texto), dtype=np.uint8))
    return bits[: forma[0] * forma[1]].reshape(forma).astype(bool)


def coberturas_cbers(cod: str, limites: list[float], itens: list[dict]) -> dict[str, tuple[float, np.ndarray | None]]:
    """Cobertura de cada cena pela máscara de dados (o quadro STAC não serve: muitas cenas são vazias dentro dele).
    Só as cenas ainda não medidas são lidas, em paralelo. Uma cena que falha fica de fora e só é tentada de novo
    depois de ESPERA_CENA_FALHA_S; se nenhuma cena do retângulo tem cobertura conhecida e as leituras falharam, o INPE
    está fora (ErroFonte)."""
    chave = chave_limites(limites)
    with _exclusivo(('cobertura', chave)):
        return _coberturas_cbers(cod, limites, itens, chave)


#: {(chave dos limites, id da cena): instante da última leitura que falhou}.
_falhas_cena: dict[tuple[str, str], float] = {}


def _coberturas_cbers(cod: str, limites: list[float], itens: list[dict], chave: str) -> dict[str, tuple[float, np.ndarray | None]]:
    largura, altura, _ = tamanho(limites, 1, LADO_COBERTURA)
    if chave not in _coberturas and len(_coberturas) >= COBERTURAS_MAX:
        del _coberturas[next(iter(_coberturas))]
    conhecidas = _coberturas.setdefault(chave, {})
    arquivo = _arquivo_cobertura(cod, chave)
    if arquivo and not conhecidas and arquivo.exists():
        try:
            d = json.loads(arquivo.read_text())
            for cena, cob in d['cenas'].items():
                m = d['mascaras'].get(cena)
                conhecidas[cena] = (cob, _decodificar(m, (altura, largura)) if m else None)
        except (OSError, ValueError, KeyError):
            log.exception('cache de cobertura ilegível: %s', arquivo)
    agora = time.monotonic()
    faltam = [it for it in itens if it['id'] not in conhecidas]
    novas = [it for it in faltam if agora - _falhas_cena.get((chave, it['id']), -math.inf) >= ESPERA_CENA_FALHA_S]
    lidas, falhas = _medir(novas, limites) if novas else ([], [])
    if falhas:
        agora = time.monotonic()
        for k in [k for k, t in _falhas_cena.items() if agora - t >= ESPERA_CENA_FALHA_S]:
            del _falhas_cena[k]
        _falhas_cena.update({(chave, cena): agora for cena in falhas})
    # Sem leitura: as que falharam agora e as que ainda esperam desde a última falha.
    sem_leitura = len(falhas) + len(faltam) - len(novas)
    if not lidas and sem_leitura and not any(it['id'] in conhecidas for it in itens):
        raise ErroFonte('CBERS-4A scenes unreadable at INPE')
    if lidas:
        for cena, m in lidas:
            cob = float(m.mean())
            conhecidas[cena] = (cob, m if 0 < cob < 1 else None)
        if arquivo:
            try:
                arquivo.parent.mkdir(parents=True, exist_ok=True)
                arquivo.write_text(json.dumps({'cenas': {c: v[0] for c, v in conhecidas.items()},
                                               'mascaras': {c: _codificar(v[1]) for c, v in conhecidas.items() if v[1] is not None}}))
            except OSError:
                log.exception('cache de cobertura não gravado: %s', arquivo)
    return {it['id']: conhecidas[it['id']] for it in itens if it['id'] in conhecidas}


def _medir(novas: list[dict], limites: list[float]) -> tuple[list[tuple[str, np.ndarray]], list[str]]:
    """(máscaras lidas, cenas sem leitura), em paralelo. Se LEITURAS_PARALELAS leituras falharem sem nenhuma dar certo,
    o INPE está fora: as que ainda não começaram são canceladas (e contam como sem leitura) em vez de esperar o prazo
    uma a uma."""
    lidas: list[tuple[str, np.ndarray]] = []
    falhas: list[str] = []
    with ThreadPoolExecutor(LEITURAS_PARALELAS) as ex:
        tarefas = {ex.submit(_mascara, _href(it, 'cbers4a'), limites): it['id'] for it in novas}
        for t in as_completed(tarefas):
            if t.cancelled():
                falhas.append(tarefas[t])
                continue
            try:
                lidas.append((tarefas[t], t.result()))
            except (RasterioIOError, OSError):
                log.warning('cobertura da cena %s não lida', tarefas[t], exc_info=True)
                falhas.append(tarefas[t])
                if not lidas and len(falhas) >= LEITURAS_PARALELAS:
                    for outra in tarefas:
                        outra.cancel()
    return lidas, falhas


def datas_cbers(cod: str, limites: list[float], itens: list[dict]) -> dict[str, tuple[float, list[dict]]]:
    """{data: (cobertura somada, cenas com dado, da mais completa para a menos)}. As cenas da mesma data se somam pelo
    OU das máscaras."""
    cobs = coberturas_cbers(cod, limites, itens)
    por: dict[str, list[dict]] = {}
    for it in itens:
        if cobs.get(it['id'], (0, None))[0] > 0:
            por.setdefault(it['properties']['datetime'][:10], []).append(it)
    out = {}
    for d, cenas in sorted(por.items()):
        cenas.sort(key=lambda it: -cobs[it['id']][0])
        if cobs[cenas[0]['id']][0] >= 1:
            total = 1.0
        else:
            total = float(np.logical_or.reduce([cobs[it['id']][1] for it in cenas]).mean())
        out[d] = (total, cenas)
    return out


# --- MapBiomas --------------------------------------------------------------------------------------------------

def _graphql(consulta: str, variaveis: dict) -> dict:
    d = _http_json(MAPBIOMAS, {'query': consulta, 'variables': variaveis})
    if d.get('errors') or not isinstance(d.get('data'), dict):
        erros = d.get('errors')
        erro = (erros[0] if erros and isinstance(erros, list) else erros) or {}
        raise ErroFonte(f'MapBiomas rejected the query: {erro.get("message", "no data") if isinstance(erro, dict) else erro}')
    return d['data']


def _lista_alertas(r) -> list[dict]:
    """Alertas com código de uma resposta do MapBiomas (`ruralProperty` ou `pointInformation`, que pode vir nulo)."""
    alertas = r.get('alerts') if isinstance(r, dict) else None
    return [a for a in alertas or [] if isinstance(a, dict) and a.get('alertCode') is not None]


def alertas_mapbiomas(cod: str) -> dict[str, dict]:
    """Alertas que o MapBiomas atribui ao imóvel, por código (texto, como em ref.car_alerta.alerta)."""
    def consulta() -> dict[str, dict]:
        return {str(a['alertCode']): a for a in _lista_alertas(_graphql(CONSULTA_IMOVEL, {'c': cod}).get('ruralProperty'))}
    return _lembrar(('mb-imovel', cod), consulta)


def alerta_no_ponto(alerta: str, lon: float, lat: float) -> dict | None:
    """O alerta pelo `pointInformation`, numa caixa pequena em volta de um ponto da geometria dele."""
    def consulta() -> dict | None:
        d = RESERVA_MEIA_CAIXA
        caixa = {'swLng': lon - d, 'swLat': lat - d, 'neLng': lon + d, 'neLat': lat + d}
        alertas = _lista_alertas(_graphql(CONSULTA_PONTO, {'b': caixa}).get('pointInformation'))
        return next((a for a in alertas if str(a['alertCode']) == alerta), None)
    return _lembrar(('mb-ponto', alerta, lon, lat), consulta)


def _reserva(a: dict) -> dict | None:
    """Passos 2 a 4: `pointInformation` no ponto do alerta; se ele trouxer `carCodes`, o `ruralProperty` do primeiro
    imóvel que tiver o alerta dá o `alertImageBbox`. Qualquer falha deixa só este alerta sem imagem nesta vez (não fica
    guardada), sem derrubar a listagem."""
    if a['lon'] is None:
        return None
    try:
        achado = alerta_no_ponto(a['alerta'], a['lon'], a['lat'])
        if achado is None:
            return None
        for c in [c for c in achado.get('carCodes') or [] if isinstance(c, str)][:RESERVA_CODIGOS]:
            try:
                completo = alertas_mapbiomas(c).get(a['alerta'])
            except ErroFonte:
                continue
            if completo:
                return completo
        return achado
    except Exception:
        log.warning('reserva do MapBiomas falhou para o alerta %s', a['alerta'], exc_info=True)
        return None



def opcoes_mapbiomas(cod: str, alertas: list[dict]) -> list[dict]:
    """Uma opção por alerta nosso (ref.car_alerta), da mais antiga para a mais recente. Alerta do MapBiomas fora do
    nosso cruzamento fica de fora (coerência com o critério EUDR). Sem alerta nosso, nem consulta o MapBiomas."""
    if not alertas:
        return []
    do_imovel = alertas_mapbiomas(cod)
    faltam = [a for a in alertas if a['alerta'] not in do_imovel]
    # Reserva para os mais recentes primeiro (os que pesam no critério EUDR); o resto sai sem imagem.
    faltam.sort(key=lambda a: a['detectado_em'], reverse=True)
    with ThreadPoolExecutor(RESERVA_PARALELAS) as ex:
        reserva = dict(zip((a['alerta'] for a in faltam[:RESERVA_MAX]), ex.map(_reserva, faltam[:RESERVA_MAX])))
    return [opcao_mapbiomas(a, do_imovel.get(a['alerta']) or reserva.get(a['alerta'])) for a in alertas]


# --- recorte e cache ----------------------------------------------------------------------------------------------

def _seguro(texto: str) -> str:
    return re.sub(r'[^A-Za-z0-9_-]', '_', texto)


def _arquivo_imagem(fonte: str, id_: str, cod: str, limites: list[float]) -> Path | None:
    pasta = os.environ.get('NT_IMAGENS_DIR')
    if not pasta:
        return None
    return Path(pasta) / fonte / _seguro(id_) / f'{_seguro(cod)}_{chave_limites(limites)}.{formato()[1]}'


def imagem_inteira(conteudo: bytes) -> bool:
    """O arquivo do cache é uma imagem completa? Pega gravação cortada (disco cheio, queda do processo), que seria
    servida como imutável por um ano."""
    if conteudo[:4] == b'RIFF' and conteudo[8:12] == b'WEBP':
        return int.from_bytes(conteudo[4:8], 'little') + 8 == len(conteudo)
    return conteudo[:2] == b'\xff\xd8' and conteudo[-2:] == b'\xff\xd9'


def _gravar(arquivo: Path, conteudo: bytes) -> None:
    """Direto no nome final: no bucket montado, o arquivo só aparece quando é fechado (renomear não tem garantia).
    O cache é um extra: se falhar, fica no log, o que sobrou é apagado e a imagem segue."""
    try:
        arquivo.parent.mkdir(parents=True, exist_ok=True)
        arquivo.write_bytes(conteudo)
    except OSError:
        log.exception('recorte não gravado no cache: %s', arquivo)
        try:
            arquivo.unlink(missing_ok=True)
        except OSError:
            pass


def _do_cache(arquivo: Path | None) -> bytes | None:
    if arquivo is None:
        return None
    try:
        if not arquivo.is_file():
            return None
        conteudo = arquivo.read_bytes()
        if imagem_inteira(conteudo):
            return conteudo
        log.warning('recorte incompleto no cache, gerado de novo: %s', arquivo)
        arquivo.unlink(missing_ok=True)
    except OSError:
        log.exception('cache ilegível: %s', arquivo)
    return None


def _falha_de_rede(e: BaseException) -> bool:
    """O INPE não respondeu (prazo, conexão, HTTP), em vez de um arquivo com defeito: aí não adianta tentar pelas
    overviews nem chamar a imagem de reduzida."""
    while e is not None:
        texto = f'{type(e).__name__} {e}'
        if 'HttpResponseError' in texto or 'CURL error' in texto or 'HTTP response code' in texto:
            return True
        e = e.__cause__ or e.__context__
    return False


def recortar_sentinel2(href: str, limites: list[float]) -> tuple[ImageData, float, bool]:
    """(imagem, resolução no terreno, completa). Tile corrompido na resolução cheia (acontece no mosaico do INPE):
    tenta pelas overviews, a 20, 40 e 80 m; a primeira que ler é a resposta. A de 20 m é sempre tentada, mesmo num
    imóvel pequeno; as seguintes, enquanto o lado maior tiver LADO_MIN_REDUZIDO px."""
    nominal = RESOLUCAO_M['sentinel2']
    largura, altura, res = tamanho(limites, nominal)
    try:
        return _ler_parte(href, limites, largura, altura), res, True
    except RasterioIOError as e:
        if _falha_de_rede(e):
            raise ErroFonte(f'data.inpe.br did not respond ({e})') from e
        log.warning('Sentinel-2 ilegível na resolução cheia: %s', href, exc_info=True)
    for n, f in enumerate(REDUCOES):
        largura, altura, res = tamanho(limites, nominal * f)
        if n and max(largura, altura) < LADO_MIN_REDUZIDO:
            break
        try:
            # A resolução é a da overview lida, mesmo que o arredondamento do tamanho dê um número um pouco menor.
            return _ler_parte(href, limites, largura, altura), max(res, nominal * f), False
        except RasterioIOError as e:
            if _falha_de_rede(e):
                raise ErroFonte(f'data.inpe.br did not respond ({e})') from e
    raise ErroFonte('INPE file is corrupted in this area')


def recortar_cbers(cenas: list[dict], limites: list[float]) -> tuple[ImageData, float]:
    largura, altura, res = tamanho(limites, RESOLUCAO_M['cbers4a'])

    def leitor(href: str, *_, **__) -> ImageData:
        return _ler_parte(href, limites, largura, altura)
    try:
        img, _ = mosaic_reader([_href(c, 'cbers4a') for c in cenas], leitor, pixel_selection=FirstMethod(), threads=len(cenas))
    except (RasterioIOError, OSError, EmptyMosaicError) as e:
        raise ErroFonte(f'CBERS-4A scene unreadable at INPE ({e})') from e
    return img, res


# --- listagem e recorte ---------------------------------------------------------------------------------------

def sem_inpe() -> bool:
    """Demo do hackathon (NT_SEM_INPE): só as imagens dos alertas do MapBiomas, que o navegador baixa direto. Os
    recortes do INPE são o que mais pesa no servidor."""
    return bool(os.environ.get('NT_SEM_INPE'))


def _exigir_inpe(fonte: str) -> None:
    if fonte != 'mapbiomas' and sem_inpe():
        raise NaoEncontrado('INPE imagery is turned off in this demo')


def listagem(cod: str, im: dict, fonte: Fonte, deteccao: date | None) -> dict:
    """Datas de imagem da fonte para o imóvel (`im`: retângulo, contorno e alertas, de consultas/) e as sugeridas para
    comparar. `deteccao` (fontes do INPE): sugere o par em volta desta data, a de um alerta do MapBiomas sem imagem
    própria, em vez das detecções dos alertas do imóvel."""
    _exigir_inpe(fonte)
    limites = limites_do_recorte(im['oeste'], im['sul'], im['leste'], im['norte'])
    if fonte == 'sentinel2':
        opcoes = opcoes_sentinel2(buscar_stac(fonte, limites))
        creditos = credito_sentinel2(opcoes)
    elif fonte == 'cbers4a':
        opcoes = opcoes_cbers(datas_cbers(cod, limites, buscar_stac(fonte, limites)))
        creditos = CREDITO_CBERS
    else:
        opcoes = opcoes_mapbiomas(cod, im['alertas'])
        creditos = credito_mapbiomas(opcoes)
    if fonte == 'mapbiomas':
        for o in opcoes:
            o['caso'] = caso_mapbiomas(o)
            o['fontes_alternativas'] = [] if sem_inpe() else fontes_da_deteccao(o['detectado_em'])
        sugestao = {'alerta': alerta_padrao(opcoes)}
    else:
        trimestral = fonte == 'sentinel2'
        deteccoes = [deteccao.isoformat()] if deteccao else [a['detectado_em'].isoformat() for a in im['alertas']]
        sugestao = pares_padrao(opcoes, deteccoes, trimestral)
        # A fonte não tem imagem dos dois lados da detecção pedida: a sugestão caiu na mais antiga e na mais recente.
        sugestao = sugestao and {**sugestao, 'cerca_deteccao': par_que_cerca(opcoes, deteccao.isoformat(), trimestral) is not None
                                 if deteccao else None}
    return {
        'fonte': fonte,
        'creditos': creditos,
        'limites': limites,
        'versao': chave_limites(limites),
        # Resolução da fonte (m); nula no MapBiomas, cujas imagens o navegador carrega direto.
        'resolucao_m': RESOLUCAO_M.get(fonte),
        'contorno': im['contorno'],
        'alertas': {'type': 'FeatureCollection', 'features': [
            {'type': 'Feature', 'geometry': a['geom'], 'properties': {'alerta': a['alerta'], 'detectado_em': a['detectado_em'].isoformat()}}
            for a in im['alertas']]},
        'opcoes': opcoes,
        'sugestao': sugestao,
    }


def imagem(cod: str, im: dict, fonte: FonteInpe, id_opcao: str) -> tuple[bytes, float, bool]:
    """(imagem, resolução no terreno, completa) do recorte de uma data, em EPSG:3857, com os cantos em `limites` da
    listagem. Dois pedidos da mesma imagem ao mesmo tempo: o segundo espera e, com o cache, lê o arquivo que o primeiro
    gravou."""
    _exigir_inpe(fonte)
    limites = limites_do_recorte(im['oeste'], im['sul'], im['leste'], im['norte'])
    with _exclusivo(('imagem', fonte, id_opcao, chave_limites(limites))):
        return _imagem(cod, fonte, id_opcao, limites)


def _imagem(cod: str, fonte: FonteInpe, id_opcao: str, limites: list[float]) -> tuple[bytes, float, bool]:
    arquivo = _arquivo_imagem(fonte, id_opcao, cod, limites)
    conteudo = _do_cache(arquivo)
    if conteudo is not None:
        return conteudo, tamanho(limites, RESOLUCAO_M[fonte])[2], True
    itens = buscar_stac(fonte, limites)
    if fonte == 'sentinel2':
        item = trimestres(itens).get(id_opcao)
        if item is None:
            raise NaoEncontrado(f'no Sentinel-2 mosaic for the quarter starting {id_opcao}')
        img, res, completa = recortar_sentinel2(_href(item, fonte), limites)
    else:
        cob, cenas = datas_cbers(cod, limites, itens).get(id_opcao, (0.0, []))
        if cob < COBERTURA_MIN:
            raise NaoEncontrado(f'no CBERS-4A scene covering the property on {id_opcao}')
        img, res = recortar_cbers(cenas, limites)
        completa = True
    conteudo = _render(img)
    # Imagem reduzida (tile corrompido) não vai para o cache: se o INPE reprocessar o arquivo, o próximo pedido pega a boa.
    if completa and arquivo:
        _gravar(arquivo, conteudo)
    return conteudo, res, completa
