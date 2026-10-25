"""Imagens históricas do imóvel (api/nodaltrace/dominio/imagens.py, servicos/imagens.py e rotas/imagens.py), sem rede: buscas STAC e respostas do MapBiomas gravadas
em tests/dados/ (2026-10-13) e COGs sintéticos criados com rasterio em `tmp_path` no lugar dos arquivos do INPE."""

from __future__ import annotations

import copy
import json
import time
from datetime import date
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.errors import RasterioIOError
from rasterio.transform import from_bounds

from nodaltrace.dominio import imagens as D
from nodaltrace.erros import NaoEncontrado
from nodaltrace.rotas import imagens as R
from nodaltrace.servicos import imagens as I

DADOS = Path(__file__).parent / 'dados'
COD = 'GO-5204805-123E98DDA6B2421AAE0FAB8CD6D08A3C'
#: Retângulo do imóvel de GO da busca gravada (sem a margem).
IMOVEL = {'oeste': -47.90717194, 'sul': -17.78816306, 'leste': -47.8822725, 'norte': -17.77304611,
          'contorno': {'type': 'Polygon', 'coordinates': [[[-47.9, -17.78], [-47.89, -17.78], [-47.89, -17.775], [-47.9, -17.78]]]}}
LIMITES = D.limites_do_recorte(IMOVEL['oeste'], IMOVEL['sul'], IMOVEL['leste'], IMOVEL['norte'])
#: O cliente HTTP de verdade, guardado antes de a fixture `limpo` trocá-lo por um que recusa a rede.
_HTTP_JSON = I._http_json


def _dados(nome: str) -> dict:
    return json.loads((DADOS / nome).read_text())


@pytest.fixture(autouse=True)
def limpo(monkeypatch):
    """Memória vazia e sem cache em disco em cada teste; nenhuma chamada de rede escapa."""
    I._memo.clear()
    I._coberturas.clear()
    I._falhas_cena.clear()
    monkeypatch.delenv('NT_IMAGENS_DIR', raising=False)

    def sem_rede(url, corpo=None):
        raise AssertionError(f'rede no teste: {url}')
    monkeypatch.setattr(I, '_http_json', sem_rede)


def _cog(caminho: Path, limites: list[float], dado: str = 'cheio', lado: int = 512) -> str:
    """GeoTIFF RGB em EPSG:4326 com nodata 0 e overviews. `dado`: 'cheio', 'vazio', 'oeste' ou 'leste' (só a metade
    de oeste ou de leste tem dado)."""
    banda = np.full((lado, lado), 120, dtype=np.uint8)
    if dado == 'vazio':
        banda[:] = 0
    elif dado == 'oeste':
        banda[:, lado // 2:] = 0
    elif dado == 'leste':
        banda[:, : lado // 2] = 0
    perfil = {'driver': 'GTiff', 'width': lado, 'height': lado, 'count': 3, 'dtype': 'uint8', 'crs': 'EPSG:4326', 'nodata': 0,
              'transform': from_bounds(*limites, lado, lado), 'tiled': True, 'blockxsize': 128, 'blockysize': 128}
    with rasterio.open(caminho, 'w', **perfil) as dst:
        for b in (1, 2, 3):
            dst.write(banda, b)
        dst.build_overviews([2, 4, 8, 16])
    return str(caminho)


def _cena(id_: str, data: str, href: str) -> dict:
    return {'id': id_, 'properties': {'datetime': f'{data}T00:00:00Z'}, 'assets': {'tci': {'href': href}}}


def _trimestre(ini: str, fim: str, href: str, proc: str = '20260101') -> dict:
    return {'id': f'MOSAIC-S2-BRAZIL-3M_V1_{ini.replace("-", "")}_{fim.replace("-", "")}_P{proc}',
            'properties': {'start_datetime': f'{ini}T00:00:00Z', 'end_datetime': f'{fim}T23:59:59Z'}, 'assets': {'visual': {'href': href}}}


# --- Sentinel-2: trimestres e rótulos ---------------------------------------------------------------------------

def test_trimestres_da_busca_gravada():
    itens = _dados('stac_sentinel2.json')['features']
    op = D.opcoes_sentinel2(itens)
    # 32 trimestres de 2018-T1 a 2026-T2; faltam 2020-T2 e 2024-T3 no catálogo.
    assert len(op) == 32 and op[0]['id'] == '2018-01-01' and op[-1]['id'] == '2026-04-01'
    assert '2020-04-01' not in {o['id'] for o in op} and '2024-07-01' not in {o['id'] for o in op}
    assert op[-1] == {'id': '2026-04-01', 'data': '2026-04-01', 'rotulo': 'Apr–Jun 2026', 'cobertura': 1.0}
    assert [o['data'] for o in op] == sorted(o['data'] for o in op)
    assert D.credito_sentinel2(op) == 'Contains modified Copernicus Sentinel data 2018–2026 · INPE/BDC mosaic'
    assert D.credito_sentinel2(op[-2:]) == 'Contains modified Copernicus Sentinel data 2026 · INPE/BDC mosaic'


def test_rotulo_trimestral():
    assert D.rotulo_trimestre('2020-10-01T00:00:00Z', '2020-12-31T23:59:59Z') == 'Oct–Dec 2020'
    assert D.rotulo_trimestre('2025-12-01', '2026-02-28') == 'Dec 2025–Feb 2026'


def test_trimestre_repetido_fica_o_processamento_mais_recente():
    a = _trimestre('2020-10-01', '2020-12-31', 'velho.tif', '20210105')
    b = _trimestre('2020-10-01', '2020-12-31', 'novo.tif', '20251027')
    assert D.trimestres([b, a])['2020-10-01']['assets']['visual']['href'] == 'novo.tif'
    assert D.trimestres([a, b])['2020-10-01']['assets']['visual']['href'] == 'novo.tif'


# --- tamanho e recorte ------------------------------------------------------------------------------------------

def test_tamanho_respeita_o_maximo_e_a_proporcao():
    largura, altura, res = D.tamanho(LIMITES, 2)
    assert max(largura, altura) <= D.LADO_MAX and res >= 1.99
    # O imóvel de GO é mais largo que alto (~3,4 × 2,2 km com a margem).
    assert largura > altura and largura / altura == pytest.approx(1.57, abs=0.05)
    grande = [-48.5, -18.5, -47.5, -17.5]
    largura, altura, res = D.tamanho(grande, 2)
    assert max(largura, altura) == D.LADO_MAX and res > 50


def test_recorte_com_tamanho_maximo(tmp_path):
    grande = [-48.5, -18.5, -47.5, -17.5]
    href = _cog(tmp_path / 's2.tif', grande, lado=1024)
    img, res, completa = I.recortar_sentinel2(href, grande)
    assert completa and max(img.width, img.height) == D.LADO_MAX and res > 50
    assert img.crs == I.WEB_MERCATOR_CRS


def test_tile_corrompido_cai_para_a_overview(tmp_path, monkeypatch):
    href = _cog(tmp_path / 's2.tif', [-48, -18, -47.8, -17.7])
    cheia = max(D.tamanho(LIMITES, 10)[:2])
    ler = I._ler_parte
    pedidos = []

    def corrompido(h, limites, largura, altura):
        pedidos.append(max(largura, altura))
        if max(largura, altura) > cheia // 2 + 1:
            raise RasterioIOError('ZIPDecode: Decoding error')
        return ler(h, limites, largura, altura)
    monkeypatch.setattr(I, '_ler_parte', corrompido)
    img, res, completa = I.recortar_sentinel2(href, LIMITES)
    assert not completa and pedidos == [cheia, max(img.width, img.height)] and res == pytest.approx(20, abs=0.5)

    monkeypatch.setattr(I, '_ler_parte', lambda *a: (_ for _ in ()).throw(RasterioIOError('ZIPDecode')))
    with pytest.raises(I.ErroFonte, match='INPE file is corrupted'):
        I.recortar_sentinel2(href, LIMITES)


# --- CBERS-4A: cobertura pela máscara -----------------------------------------------------------------------------

@pytest.fixture
def cenas(tmp_path):
    """Quadros que cobrem o retângulo inteiro: uma cena vazia (como as do INPE dentro do quadro), uma cheia, e duas
    parciais da mesma data que juntas cobrem tudo; mais uma parcial sozinha noutra data."""
    quadro = [LIMITES[0] - 0.01, LIMITES[1] - 0.01, LIMITES[2] + 0.01, LIMITES[3] + 0.01]
    meio = (LIMITES[0] + LIMITES[2]) / 2
    oeste = [quadro[0], quadro[1], meio + 0.0005, quadro[3]]
    leste = [meio - 0.0005, quadro[1], quadro[2], quadro[3]]
    return [
        _cena('vazia', '2024-01-10', _cog(tmp_path / 'vazia.tif', quadro, 'vazio')),
        _cena('cheia', '2024-02-10', _cog(tmp_path / 'cheia.tif', quadro)),
        _cena('oeste', '2024-03-10', _cog(tmp_path / 'oeste.tif', oeste)),
        _cena('leste', '2024-03-10', _cog(tmp_path / 'leste.tif', leste)),
        _cena('so-oeste', '2024-04-10', _cog(tmp_path / 'so-oeste.tif', oeste)),
    ]


def test_cobertura_pela_mascara(cenas):
    datas = I.datas_cbers(COD, LIMITES, cenas)
    # A cena vazia não entra; as duas parciais da mesma data somam pelo OU das máscaras.
    assert set(datas) == {'2024-02-10', '2024-03-10', '2024-04-10'}
    assert datas['2024-02-10'][0] == 1.0
    assert datas['2024-03-10'][0] == pytest.approx(1.0, abs=0.01)
    assert datas['2024-04-10'][0] == pytest.approx(0.5, abs=0.05)
    cobs = I.coberturas_cbers(COD, LIMITES, cenas)
    assert cobs['vazia'][0] == 0 and 0.4 < cobs['oeste'][0] < 0.6 and 0.4 < cobs['leste'][0] < 0.6
    assert [o['id'] for o in D.opcoes_cbers(datas)] == ['2024-02-10', '2024-03-10']
    assert D.opcoes_cbers(datas)[0] == {'id': '2024-02-10', 'data': '2024-02-10', 'rotulo': 'Feb 10, 2024', 'cobertura': 1.0}


def test_cobertura_guardada_so_le_cenas_novas(cenas, tmp_path, monkeypatch):
    monkeypatch.setenv('NT_IMAGENS_DIR', str(tmp_path / 'cache'))
    lidas = []
    mascara = I._mascara
    monkeypatch.setattr(I, '_mascara', lambda h, l: lidas.append(h) or mascara(h, l))
    antes = I.datas_cbers(COD, LIMITES, cenas[:4])
    assert len(lidas) == 4
    arquivo = tmp_path / 'cache' / 'cbers4a' / 'cobertura' / f'{COD}_{D.chave_limites(LIMITES)}.json'
    assert set(json.loads(arquivo.read_text())['cenas']) == {'vazia', 'cheia', 'oeste', 'leste'}
    # Outro processo (memória vazia): lê do arquivo, inclusive as máscaras das parciais, e só mede a cena nova.
    I._coberturas.clear()
    lidas.clear()
    depois = I.datas_cbers(COD, LIMITES, cenas)
    assert lidas == [cenas[4]['assets']['tci']['href']]
    assert depois['2024-03-10'][0] == antes['2024-03-10'][0]


# --- MapBiomas ------------------------------------------------------------------------------------------------

class MapBiomas:
    """GraphQL falso a partir das respostas gravadas: `ruralProperty` por código e `pointInformation` pelo ponto."""

    def __init__(self):
        g = _dados('mapbiomas.json')
        self.imoveis = {c: r['data']['ruralProperty']['alerts'] for c, r in g['ruralProperty'].items()}
        self.pontos: list[tuple[float, float, dict]] = []
        self.chamadas: list[tuple[str, object]] = []
        self.gravado = g

    def __call__(self, url, corpo=None):
        assert url == I.MAPBIOMAS
        v = corpo['variables']
        if 'ruralProperty' in corpo['query']:
            self.chamadas.append(('imovel', v['c']))
            return {'data': {'ruralProperty': {'alerts': self.imoveis[v['c']]} if v['c'] in self.imoveis else None}}
        b = v['b']
        self.chamadas.append(('ponto', b))
        achados = [a for lon, lat, a in self.pontos if b['swLng'] <= lon <= b['neLng'] and b['swLat'] <= lat <= b['neLat']]
        return {'data': {'pointInformation': {'alerts': achados}}}


def _imovel_falso(**im):
    """No lugar de rotas.imagens._imovel (o banco): só o imóvel COD existe."""
    def falso(cod, com_alertas=False):
        if cod != COD:
            raise NaoEncontrado(f'CAR {cod} not found')
        return copy.deepcopy(im)
    return falso


def _alerta(codigo: str, detectado: str, lon: float | None = -47.0, lat: float | None = -17.0) -> dict:
    return {'alerta': codigo, 'detectado_em': date.fromisoformat(detectado), 'lon': lon, 'lat': lat,
            'geom': {'type': 'MultiPolygon', 'coordinates': []}}


def test_mapbiomas_nos_cinco_casos(monkeypatch):
    mb = MapBiomas()
    monkeypatch.setattr(I, '_http_json', mb)
    go = mb.imoveis[COD]
    # Caso 1: o alerta 965011 vem no ruralProperty do imóvel. O 123, também, mas não está no nosso car_alerta.
    go.append({**go[0], 'alertCode': 123})
    # Casos 2 e 3: a lasca 555109 só aparece no ponto, com carCodes; o primeiro código não tem o alerta, o segundo sim.
    pr = copy.deepcopy(mb.gravado['pointInformation']['555109']['data']['pointInformation']['alerts'][0])
    pr['carCodes'] = ['PR-SEM-O-ALERTA', 'PR-4103354-92624E4F77524ABC959C3D5150583448']
    mb.imoveis['PR-SEM-O-ALERTA'] = []
    mb.pontos.append((-53.171, -24.8557, pr))
    # Caso 4: no ponto, sem carCodes (imóvel que o MapBiomas não conhece).
    am = mb.gravado['pointInformation']['1291443']['data']['pointInformation']['alerts'][0]
    mb.pontos.append((-63.0124, -7.0276, am))
    alertas = [
        _alerta('555109', '2022-02-28', -53.171, -24.8557),
        _alerta('965011', '2023-06-01'),
        _alerta('1291443', '2024-08-01', -63.0124, -7.0276),
        _alerta('999', '2025-01-01', -50.0, -10.0),  # caso 5: em nenhum
        _alerta('998', '2025-02-01', None, None),  # sem a geometria do alerta em ref.feicao_ambiental: sem reserva
    ]
    op = {o['alerta']: o for o in I.opcoes_mapbiomas(COD, alertas)}
    assert list(op) == ['555109', '965011', '1291443', '999', '998']
    assert op['965011']['limites'] == pytest.approx([-47.89365077609065, -17.793415565149125, -47.87675153123084, -17.77651632028931])
    assert op['965011']['antes'] == {'data': '2023-04-29', 'url': 'https://image.alerta.mapbiomas.org/image/alert/970296/before_deforestation.png',
                                     'constelacao': 'Sentinel-2'}
    assert op['555109']['limites'] == pytest.approx([-53.17511000015011, -24.86054350015012, -53.166141999849884, -24.85157549984989])
    assert op['555109']['depois']['data'] == '2021-12-28' and op['555109']['detectado_em'] == '2022-02-28'
    assert op['1291443']['limites'] is None and op['1291443']['antes']['constelacao'] == 'PlanetScope'
    assert op['1291443']['depois']['url'].endswith('/1296728/after_deforestation.png')
    for c in ('999', '998'):
        assert (op[c]['limites'], op[c]['antes'], op[c]['depois']) == (None, None, None)
    # A caixa do pointInformation é pequena e centrada no ponto do alerta.
    caixa = next(b for t, b in mb.chamadas if t == 'ponto')
    assert caixa['neLng'] - caixa['swLng'] == pytest.approx(2 * I.RESERVA_MEIA_CAIXA)
    assert ('imovel', 'PR-SEM-O-ALERTA') in mb.chamadas
    assert 'MapBiomas Alerta – High-Resolution' in D.credito_mapbiomas(list(op.values()))
    assert D.credito_mapbiomas(list(op.values())).endswith('· images PlanetScope, Sentinel-2')
    # Guardado em memória: repetir não consulta de novo.
    n = len(mb.chamadas)
    I.opcoes_mapbiomas(COD, alertas)
    assert len(mb.chamadas) == n


def test_mapbiomas_teto_de_reserva(monkeypatch):
    mb = MapBiomas()
    monkeypatch.setattr(I, '_http_json', mb)
    alertas = [_alerta(str(1000 + i), f'2024-01-{i + 1:02d}', -50 + i * 0.01, -10.0) for i in range(25)]
    op = I.opcoes_mapbiomas(COD, alertas)
    pontos = [b for t, b in mb.chamadas if t == 'ponto']
    assert len(op) == 25 and len(pontos) == I.RESERVA_MAX
    # Os mais recentes ganham a reserva.
    assert min(b['swLng'] for b in pontos) > -50 + 4 * 0.01 - 0.001


def test_mapbiomas_fora_do_ar_da_502(api, monkeypatch):
    monkeypatch.setattr(R, '_imovel', _imovel_falso(**IMOVEL, alertas=[_alerta('1', '2024-01-01')]))

    def fora(url, corpo=None):
        raise I.ErroFonte('plataforma.alerta.mapbiomas.org did not respond (timed out)')
    monkeypatch.setattr(I, '_http_json', fora)
    r = api.get(f'/car/{COD}/imagens', params={'fonte': 'mapbiomas'})
    assert r.status_code == 502 and 'did not respond' in r.json()['detail']


def test_sem_inpe_so_o_mapbiomas(api, monkeypatch):
    """Demo (NT_SEM_INPE): as fontes do INPE dão 404 sem ir à rede e o MapBiomas não sugere atalho para elas."""
    monkeypatch.setenv('NT_SEM_INPE', '1')
    monkeypatch.setattr(R, '_imovel', _imovel_falso(**IMOVEL, alertas=[_alerta('965011', '2023-06-01')]))
    monkeypatch.setattr(I, 'buscar_stac', lambda *a: pytest.fail('buscou no STAC com o INPE desligado'))
    for fonte in ('sentinel2', 'cbers4a'):
        assert api.get(f'/car/{COD}/imagens', params={'fonte': fonte}).status_code == 404
        assert api.get(f'/car/{COD}/imagens/{fonte}/2024-01-01').status_code == 404
    monkeypatch.setattr(I, '_http_json', MapBiomas())
    d = api.get(f'/car/{COD}/imagens', params={'fonte': 'mapbiomas'}).json()
    assert d['opcoes'] and all(o['fontes_alternativas'] == [] for o in d['opcoes'])


# --- rotas --------------------------------------------------------------------------------------------------------

@pytest.fixture
def inpe(tmp_path, monkeypatch, cenas):
    """API com o imóvel de GO, um trimestre do Sentinel-2 e as cenas sintéticas do CBERS-4A."""
    s2 = _cog(tmp_path / 's2.tif', [-48, -18, -47.8, -17.7])
    itens = {'sentinel2': [_trimestre('2024-01-01', '2024-03-31', s2)], 'cbers4a': cenas}
    monkeypatch.setattr(R, '_imovel', _imovel_falso(**IMOVEL, alertas=[_alerta('965011', '2023-06-01')]))
    monkeypatch.setattr(I, 'buscar_stac', lambda fonte, limites: itens[fonte])
    return itens


def test_listagem(api, inpe):
    r = api.get(f'/car/{COD}/imagens', params={'fonte': 'cbers4a'})
    assert r.status_code == 200
    d = r.json()
    assert d['fonte'] == 'cbers4a' and d['creditos'] == D.CREDITO_CBERS
    assert d['limites'] == pytest.approx(LIMITES) and d['versao'] == D.chave_limites(LIMITES)
    assert d['contorno'] == IMOVEL['contorno']
    assert d['alertas']['features'][0]['properties'] == {'alerta': '965011', 'detectado_em': '2023-06-01'}
    assert [o['id'] for o in d['opcoes']] == ['2024-02-10', '2024-03-10']
    # O alerta de 2023 é anterior às cenas: a sugestão cai na mais antiga e na mais recente.
    assert d['sugestao'] == {'antes': '2024-02-10', 'depois': '2024-03-10', 'cerca_deteccao': None}
    s2 = api.get(f'/car/{COD}/imagens', params={'fonte': 'sentinel2'}).json()
    assert s2['opcoes'] == [{'id': '2024-01-01', 'data': '2024-01-01', 'rotulo': 'Jan–Mar 2024', 'cobertura': 1.0}]


def test_listagem_sugere_o_par_em_volta_da_deteccao_pedida(api, inpe):
    d = api.get(f'/car/{COD}/imagens', params={'fonte': 'cbers4a', 'deteccao': '2024-03-01'}).json()
    assert d['sugestao'] == {'antes': '2024-02-10', 'depois': '2024-03-10', 'cerca_deteccao': True}
    d = api.get(f'/car/{COD}/imagens', params={'fonte': 'cbers4a', 'deteccao': '2022-01-01'}).json()
    assert d['sugestao']['cerca_deteccao'] is False
    assert api.get(f'/car/{COD}/imagens', params={'fonte': 'cbers4a', 'deteccao': 'ontem'}).status_code == 422


def test_imagem_cache_gravado_e_relido(api, inpe, tmp_path, monkeypatch):
    monkeypatch.setenv('NT_IMAGENS_DIR', str(tmp_path / 'cache'))
    r = api.get(f'/car/{COD}/imagens/cbers4a/2024-03-10')
    assert r.status_code == 200 and r.headers['content-type'] == 'image/webp' and r.content[8:12] == b'WEBP'
    assert r.headers['cache-control'] == 'public, max-age=31536000, immutable' and r.headers['x-resolucao-metros'] == '2'
    arquivo = tmp_path / 'cache' / 'cbers4a' / '2024-03-10' / f'{COD}_{D.chave_limites(LIMITES)}.webp'
    assert arquivo.read_bytes() == r.content
    # Do disco: nenhuma leitura de COG nem busca STAC.
    monkeypatch.setattr(I, '_ler_parte', lambda *a: pytest.fail('leu o COG com o recorte no cache'))
    monkeypatch.setattr(I, 'buscar_stac', lambda *a: pytest.fail('buscou no STAC com o recorte no cache'))
    de_novo = api.get(f'/car/{COD}/imagens/cbers4a/2024-03-10')
    assert de_novo.status_code == 200 and de_novo.content == r.content and de_novo.headers['x-resolucao-metros'] == '2'


def test_falha_na_gravacao_nao_derruba_o_pedido(api, inpe, tmp_path, monkeypatch):
    ocupado = tmp_path / 'arquivo'
    ocupado.write_text('não é pasta')
    monkeypatch.setenv('NT_IMAGENS_DIR', str(ocupado))
    r = api.get(f'/car/{COD}/imagens/sentinel2/2024-01-01')
    assert r.status_code == 200 and r.headers['x-resolucao-metros'] == '10'


def test_imagem_reduzida_sem_cache(api, inpe, tmp_path, monkeypatch):
    monkeypatch.setenv('NT_IMAGENS_DIR', str(tmp_path / 'cache'))
    cheia = max(D.tamanho(LIMITES, 10)[:2])
    ler = I._ler_parte

    def corrompido(h, limites, largura, altura):
        if max(largura, altura) >= cheia:
            raise RasterioIOError('TIFFReadEncodedTile() failed')
        return ler(h, limites, largura, altura)
    monkeypatch.setattr(I, '_ler_parte', corrompido)
    r = api.get(f'/car/{COD}/imagens/sentinel2/2024-01-01')
    assert r.status_code == 200 and r.headers['cache-control'] == 'no-store'
    assert float(r.headers['x-resolucao-metros']) == pytest.approx(20, abs=0.5)
    assert not (tmp_path / 'cache').exists()
    monkeypatch.setattr(I, '_ler_parte', lambda *a: (_ for _ in ()).throw(RasterioIOError('ZIPDecode')))
    r = api.get(f'/car/{COD}/imagens/sentinel2/2024-01-01')
    assert r.status_code == 502 and r.json()['detail'] == 'INPE file is corrupted in this area'


def test_formato_conforme_o_driver(api, inpe, monkeypatch):
    monkeypatch.setattr(I, 'formato', lambda: ('JPEG', 'jpg', 'image/jpeg'))
    r = api.get(f'/car/{COD}/imagens/sentinel2/2024-01-01')
    assert r.status_code == 200 and r.headers['content-type'] == 'image/jpeg' and r.content[:2] == b'\xff\xd8'


def test_erros(api, inpe, monkeypatch):
    assert api.get('/car/XX-0000000-NAO-EXISTE/imagens', params={'fonte': 'sentinel2'}).status_code == 404
    assert api.get('/car/XX-0000000-NAO-EXISTE/imagens/sentinel2/2024-01-01').status_code == 404
    assert api.get(f'/car/{COD}/imagens', params={'fonte': 'landsat'}).status_code == 422
    assert api.get(f'/car/{COD}/imagens').status_code == 422
    assert api.get(f'/car/{COD}/imagens/mapbiomas/965011').status_code == 422
    # Trimestre fora do catálogo; data do CBERS sem cena, com cena vazia ou com cobertura parcial.
    assert api.get(f'/car/{COD}/imagens/sentinel2/2020-04-01').status_code == 404
    for d in ('2024-05-10', '2024-01-10', '2024-04-10'):
        assert api.get(f'/car/{COD}/imagens/cbers4a/{d}').status_code == 404, d

    def fora(url, corpo=None):
        raise I.ErroFonte('data.inpe.br did not respond (timed out)')
    monkeypatch.setattr(I, 'buscar_stac', lambda fonte, limites: fora(''))
    r = api.get(f'/car/{COD}/imagens', params={'fonte': 'sentinel2'})
    assert r.status_code == 502 and 'data.inpe.br' in r.json()['detail']


def test_imagem_no_banco_real(api):
    """A consulta do imóvel e dos alertas roda no banco (pula se nenhum imóvel com alerta estiver carregado)."""
    from nodaltrace.banco import pool
    with pool.connection() as con:
        r = con.execute("SELECT cod_imovel FROM ref.car_alerta WHERE camada_id = ref.camada_vigente('mapbiomas') LIMIT 1").fetchone()
    if r is None:
        pytest.skip('sem alertas do MapBiomas carregados')
    im = R._imovel(r['cod_imovel'], True)
    assert im['oeste'] < im['leste'] and im['sul'] < im['norte'] and im['contorno']['type'] in ('Polygon', 'MultiPolygon')
    assert im['alertas'] and {'alerta', 'detectado_em', 'geom', 'lon', 'lat'} <= set(im['alertas'][0])
    assert [a['detectado_em'] for a in im['alertas']] == sorted(a['detectado_em'] for a in im['alertas'])
    with pytest.raises(NaoEncontrado):
        R._imovel('XX-0000000-NAO-EXISTE', True)


# --- robustez (achados da revisão de 2026-10-13) ------------------------------------------------------------------

def test_tamanho_degenerado():
    assert D.tamanho([-47.9, -17.7, -47.9, -17.7], 10) == (1, 1, 10)


def test_imovel_pequeno_com_tile_corrompido_ainda_sai_a_20_m(tmp_path, monkeypatch):
    # ~200 m de lado: 27 px na resolução cheia, 14 px a 20 m (abaixo do piso, mas a de 20 m é sempre tentada).
    pequeno = D.limites_do_recorte(-46.9572, -23.5985, -46.9555, -23.5968)
    href = _cog(tmp_path / 's2.tif', [-47, -23.7, -46.9, -23.5])
    cheia = max(D.tamanho(pequeno, 10)[:2])
    ler = I._ler_parte

    def corrompido(h, limites, largura, altura):
        if max(largura, altura) >= cheia:
            raise RasterioIOError('ZIPDecode: Decoding error')
        return ler(h, limites, largura, altura)
    monkeypatch.setattr(I, '_ler_parte', corrompido)
    img, res, completa = I.recortar_sentinel2(href, pequeno)
    assert not completa and max(img.width, img.height) < I.LADO_MIN_REDUZIDO and res == 20


@pytest.mark.filterwarnings('ignore::rasterio.errors.NotGeoreferencedWarning')
def test_webp_com_transparencia_onde_nao_ha_dado(api, inpe, tmp_path):
    # Metade de oeste do retângulo sem dado: o WebP leva o canal alfa.
    meio = (LIMITES[0] + LIMITES[2]) / 2
    inpe['sentinel2'][0]['assets']['visual']['href'] = _cog(tmp_path / 'leste.tif', [meio, -18, -47.8, -17.7])
    r = api.get(f'/car/{COD}/imagens/sentinel2/2024-01-01')
    with rasterio.MemoryFile(r.content) as mf, mf.open() as ds:
        bandas, alfa = ds.count, ds.read(4)
    assert bandas == 4 and alfa[:, : alfa.shape[1] // 3].max() == 0 and alfa[:, -alfa.shape[1] // 3:].min() == 255


def test_reducao_por_tamanho_no_cabecalho(api, inpe, monkeypatch, tmp_path):
    grande = {**IMOVEL, 'oeste': -48.2, 'sul': -18.2, 'leste': -47.6, 'norte': -17.6}
    monkeypatch.setattr(R, '_imovel', _imovel_falso(**grande, alertas=[]))
    inpe['sentinel2'][0]['assets']['visual']['href'] = _cog(tmp_path / 's2g.tif', [-48.5, -18.5, -47.3, -17.3])
    r = api.get(f'/car/{COD}/imagens/sentinel2/2024-01-01')
    assert r.status_code == 200 and r.headers['x-reducao'] == 'tamanho' and float(r.headers['x-resolucao-metros']) > 40
    assert 'immutable' in r.headers['cache-control']
    normal = api.get(f'/car/{COD}/imagens', params={'fonte': 'sentinel2'}).json()
    assert normal['resolucao_m'] == 10


def test_cabecalho_do_defeito_do_inpe(api, inpe, monkeypatch):
    ler = I._ler_parte
    cheia = max(D.tamanho(LIMITES, 10)[:2])
    monkeypatch.setattr(I, '_ler_parte', lambda h, l, w, a: (_ for _ in ()).throw(RasterioIOError('x')) if max(w, a) >= cheia else ler(h, l, w, a))
    r = api.get(f'/car/{COD}/imagens/sentinel2/2024-01-01')
    assert r.headers['x-reducao'] == 'defeito-inpe' and r.headers['x-resolucao-metros'] == '20'
    assert 'x-reducao' not in api.get(f'/car/{COD}/imagens/cbers4a/2024-02-10').headers


def test_cache_cortado_e_descartado(api, inpe, tmp_path, monkeypatch):
    monkeypatch.setenv('NT_IMAGENS_DIR', str(tmp_path / 'cache'))
    inteira = api.get(f'/car/{COD}/imagens/sentinel2/2024-01-01').content
    arquivo = tmp_path / 'cache' / 'sentinel2' / '2024-01-01' / f'{COD}_{D.chave_limites(LIMITES)}.webp'
    assert I.imagem_inteira(inteira) and not I.imagem_inteira(inteira[:-10]) and not I.imagem_inteira(b'')
    arquivo.write_bytes(inteira[: len(inteira) // 2])
    r = api.get(f'/car/{COD}/imagens/sentinel2/2024-01-01')
    assert r.content == inteira and arquivo.read_bytes() == inteira


def test_gravacao_que_falha_no_meio_nao_deixa_resto(tmp_path, monkeypatch):
    arquivo = tmp_path / 'a' / 'b.webp'

    def cheio(self, dados):
        Path.write_text(self, 'meio')
        raise OSError(28, 'No space left on device')
    monkeypatch.setattr(Path, 'write_bytes', cheio)
    I._gravar(arquivo, b'RIFF')
    assert not arquivo.exists()


def test_id_da_opcao_invalido(api, inpe, tmp_path, monkeypatch):
    monkeypatch.setenv('NT_IMAGENS_DIR', str(tmp_path))
    (tmp_path / 'sentinel2').mkdir()
    for id_ in ('x' * 300, '2024-01-01x', '2024-1-01'):
        assert api.get(f'/car/{COD}/imagens/sentinel2/{id_}').status_code == 404, id_


def test_cbers_com_o_inpe_fora_da_502(api, inpe, monkeypatch):
    monkeypatch.setattr(I, '_mascara', lambda h, l: (_ for _ in ()).throw(RasterioIOError('HTTP 503')))
    r = api.get(f'/car/{COD}/imagens', params={'fonte': 'cbers4a'})
    assert r.status_code == 502 and 'CBERS-4A' in r.json()['detail']


def test_pedidos_simultaneos_medem_cada_cena_uma_vez(cenas, monkeypatch):
    import threading
    lidas = []
    mascara = I._mascara
    monkeypatch.setattr(I, '_mascara', lambda h, l: lidas.append(h) or mascara(h, l))
    ts = [threading.Thread(target=I.datas_cbers, args=(COD, LIMITES, cenas)) for _ in range(3)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert sorted(lidas) == sorted(c['assets']['tci']['href'] for c in cenas)


def test_agrupamento_por_data_na_busca_gravada(monkeypatch):
    feats = _dados('stac_cbers4a.json')['features']
    assert all(I._item_valido(f, 'cbers4a') for f in feats)
    # Na órbita 206, a cena do ponto 135 tem metade do retângulo e a do 136, a outra metade: juntas, na mesma data,
    # cobrem tudo. As da órbita 205 estão inteiras.
    largura, altura, _ = D.tamanho(LIMITES, 1, I.LADO_COBERTURA)
    oeste = np.zeros((altura, largura), bool)
    oeste[:, : largura // 2 + 1] = True
    monkeypatch.setattr(I, '_mascara', lambda h, l: oeste if h.endswith('_206_135.tif') else ~oeste if h.endswith('_206_136.tif') else oeste | True)
    datas = I.datas_cbers(COD, LIMITES, feats)
    assert len(datas) == 28
    assert datas['2024-07-10'][0] == 1.0 and len(datas['2024-07-10'][1]) == 2
    assert datas['2023-07-04'][0] == 1.0  # datetime às 03:00 UTC: a data é a do dia
    assert datas['2025-07-17'][0] == pytest.approx(0.5, abs=0.05) and len(datas['2025-07-17'][1]) == 1
    assert datas['2025-10-23'][0] == 1.0  # órbita 205: cena inteira


def test_busca_stac_pagina_filtra_e_guarda(monkeypatch):
    feats = _dados('stac_sentinel2.json')['features']
    estranho = copy.deepcopy(feats[0])
    estranho['assets']['visual']['href'] = 'file:///etc/passwd'
    sem_data = copy.deepcopy(feats[1])
    del sem_data['properties']['start_datetime']
    paginas = [{'features': feats[:10] + [estranho, sem_data], 'links': [{'rel': 'next', 'href': f'{I.STAC}/search?page=2', 'method': 'GET'}]},
               {'features': feats[10:], 'links': []}]
    pedidos = []

    def http(url, corpo=None):
        pedidos.append((url, corpo))
        return paginas[len(pedidos) - 1]
    monkeypatch.setattr(I, '_http_json', http)
    itens = I.buscar_stac('sentinel2', LIMITES)
    assert len(itens) == len(feats) and estranho not in itens and sem_data not in itens
    assert pedidos[0][1] == {'collections': ['mosaic-s2-brazil-3m-1'], 'bbox': LIMITES, 'limit': 500}
    assert pedidos[1] == (f'{I.STAC}/search?page=2', None)
    assert I.buscar_stac('sentinel2', LIMITES) is itens and len(pedidos) == 2

    I._memo.clear()
    paginas[0]['links'][0]['href'] = 'http://169.254.169.254/latest'
    pedidos.clear()
    with pytest.raises(I.ErroFonte, match='another address'):
        I.buscar_stac('sentinel2', LIMITES)


def test_memoria_descarta_o_que_venceu(monkeypatch):
    agora = [1000.0]
    monkeypatch.setattr(I.time, 'monotonic', lambda: agora[0])
    I._lembrar(('a',), lambda: 1)
    agora[0] += I.VALIDADE_S + 1
    I._lembrar(('b',), lambda: 2)
    assert ('a',) not in I._memo and ('b',) in I._memo


@pytest.fixture
def servidor_ruim():
    """HTTP local que fecha a conexão sem resposta, corta o corpo ou responde JSON que não é objeto."""
    import socket
    import threading

    def atender(c: socket.socket):
        pedido = c.recv(65536).decode(errors='replace')
        caminho = pedido.split(' ')[1] if ' ' in pedido else '/'
        if caminho == '/cortado':
            c.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"a": ')
        elif caminho == '/lista':
            c.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n[]')
        c.close()

    s = socket.create_server(('127.0.0.1', 0))

    def laco():
        while True:
            try:
                c, _ = s.accept()
            except OSError:
                return
            atender(c)
    threading.Thread(target=laco, daemon=True).start()
    yield f'http://127.0.0.1:{s.getsockname()[1]}'
    s.close()


@pytest.mark.parametrize('caminho', ['/fechado', '/cortado', '/lista'])
def test_falhas_de_rede_viram_erro_da_fonte(servidor_ruim, caminho):
    with pytest.raises(I.ErroFonte):
        _HTTP_JSON(servidor_ruim + caminho, {'q': 1})


def test_falha_na_reserva_deixa_so_aquele_alerta_sem_imagem(monkeypatch):
    mb = MapBiomas()
    monkeypatch.setattr(I, '_http_json', mb)
    real = I.alerta_no_ponto
    monkeypatch.setattr(I, 'alerta_no_ponto', lambda a, lon, lat: (_ for _ in ()).throw(ConnectionResetError()) if a == '1' else real(a, lon, lat))
    am = mb.gravado['pointInformation']['1291443']['data']['pointInformation']['alerts'][0]
    mb.pontos.append((-63.0124, -7.0276, am))
    op = {o['alerta']: o for o in I.opcoes_mapbiomas(COD, [_alerta('1', '2024-01-01'), _alerta('1291443', '2024-08-01', -63.0124, -7.0276)])}
    assert op['1']['antes'] is None and op['1291443']['antes'] is not None


def test_mapbiomas_sem_alerta_nosso_nem_consulta():
    # A fixture `limpo` falha o teste se houver rede.
    assert I.opcoes_mapbiomas(COD, []) == []


def test_mapbiomas_com_resposta_estranha(monkeypatch):
    monkeypatch.setattr(I, '_http_json', lambda url, corpo=None: {'data': None})
    with pytest.raises(I.ErroFonte):
        I.alertas_mapbiomas(COD)
    monkeypatch.setattr(I, '_http_json', lambda url, corpo=None: {'data': {'ruralProperty': {'alerts': [None, {'x': 1}, {'alertCode': 7}]}}})
    I._memo.clear()
    assert list(I.alertas_mapbiomas(COD)) == ['7']


def test_ponto_da_reserva_vem_do_alerta_inteiro(api):
    """O ponto é da geometria do alerta em ref.feicao_ambiental, não da lasca no imóvel (pula sem alertas)."""
    from nodaltrace.banco import pool
    with pool.connection() as con:
        r = con.execute(
            """SELECT c.cod_imovel, c.alerta, ST_X(ST_PointOnSurface(f.geom)) AS lon, ST_Y(ST_PointOnSurface(f.geom)) AS lat
               FROM ref.car_alerta c JOIN ref.feicao_ambiental f ON f.camada_id = c.camada_id AND f.externo_id = c.alerta
               WHERE c.camada_id = ref.camada_vigente('mapbiomas') AND NOT ST_Equals(ST_PointOnSurface(c.geom), ST_PointOnSurface(f.geom))
               LIMIT 1""").fetchone()
    if r is None:
        pytest.skip('sem alertas do MapBiomas carregados')
    a = next(a for a in R._imovel(r['cod_imovel'], True)['alertas'] if a['alerta'] == r['alerta'])
    assert (a['lon'], a['lat']) == pytest.approx((r['lon'], r['lat']))


# --- segunda revisão (2026-10-13) ---------------------------------------------------------------------------------

def test_cena_que_falha_nao_derruba_as_conhecidas(cenas, monkeypatch):
    I.datas_cbers(COD, LIMITES, cenas[:2])
    ruim = _cena('ruim', '2024-06-10', '/nao/existe.tif')
    lidas = []
    mascara = I._mascara
    monkeypatch.setattr(I, '_mascara', lambda h, l: lidas.append(h) or mascara(h, l))
    for _ in range(3):
        assert set(I.datas_cbers(COD, LIMITES, [*cenas[:2], ruim])) == {'2024-02-10'}
    # A cena ruim é lida uma vez e espera ESPERA_CENA_FALHA_S antes de outra tentativa.
    assert lidas == ['/nao/existe.tif']


def test_inpe_fora_cancela_as_leituras_que_faltam(monkeypatch):
    lidas = []

    def fora(h, l):
        lidas.append(h)
        time.sleep(0.05)  # o prazo de conexão, em miniatura
        raise RasterioIOError('CURL error: Failed to connect')
    monkeypatch.setattr(I, '_mascara', fora)
    muitas = [_cena(f'c{i}', '2024-01-01', f'/c{i}.tif') for i in range(60)]
    with pytest.raises(I.ErroFonte):
        I.coberturas_cbers(COD, LIMITES, muitas)
    assert len(lidas) < 30
    # Logo depois, nem lê: as cenas esperam desde a falha, e o INPE continua dado como fora.
    lidas.clear()
    with pytest.raises(I.ErroFonte):
        I.coberturas_cbers(COD, LIMITES, muitas)
    assert lidas == []


def test_falha_guardada_por_pouco_tempo_e_sem_fila(monkeypatch):
    import threading
    chamadas = []

    def falha():
        chamadas.append(1)
        time.sleep(0.2)
        raise I.ErroFonte('fora')

    def pedir():
        with pytest.raises(I.ErroFonte):
            I._lembrar(('x',), falha)
    ts = [threading.Thread(target=pedir) for _ in range(4)]
    inicio = time.monotonic()
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert len(chamadas) == 1 and time.monotonic() - inicio < 0.6
    assert I._travas == {}
    agora = time.monotonic()
    monkeypatch.setattr(I.time, 'monotonic', lambda: agora + I.VALIDADE_FALHA_S + 1)
    assert I._lembrar(('x',), lambda: 'voltou') == 'voltou'


def test_inpe_sem_resposta_nao_vira_defeito(tmp_path, monkeypatch):
    pedidos = []

    def fora(h, limites, largura, altura):
        pedidos.append(largura)
        raise RasterioIOError('CURL error: Operation timed out after 15001 milliseconds')
    monkeypatch.setattr(I, '_ler_parte', fora)
    with pytest.raises(I.ErroFonte, match='did not respond'):
        I.recortar_sentinel2('https://data.inpe.br/x.tif', LIMITES)
    assert len(pedidos) == 1


def test_graphql_com_erros_em_objeto(monkeypatch):
    monkeypatch.setattr(I, '_http_json', lambda url, corpo=None: {'errors': {'message': 'limite'}})
    with pytest.raises(I.ErroFonte, match='limite'):
        I.alertas_mapbiomas(COD)


# --- datas sugeridas para comparar (antes no frontend, web/src/map/historico.ts) ---------------------------------

def _opcoes(*datas: str) -> list[dict]:
    return [{'id': d, 'data': d, 'rotulo': d, 'cobertura': 1.0} for d in datas]


S2 = _opcoes('2022-07-01', '2022-10-01', '2023-01-01', '2023-04-01', '2023-07-01', '2023-10-01')
CBERS = _opcoes('2023-04-02', '2023-05-30', '2023-06-01', '2023-07-04')


def test_pares_padrao_sem_alerta():
    assert D.pares_padrao(S2, [], True) == {'antes': '2022-07-01', 'depois': '2023-10-01'}


def test_pares_padrao_trimestre_da_deteccao_fica_de_fora():
    # Detecção em junho: o trimestre abr–jun mistura dias de antes e de depois.
    assert D.pares_padrao(S2, ['2023-06-01'], True) == {'antes': '2023-01-01', 'depois': '2023-07-01'}
    assert D.pares_padrao(S2, ['2023-04-01'], True) == {'antes': '2023-01-01', 'depois': '2023-04-01'}


def test_pares_padrao_cbers_cena_do_dia_e_a_de_depois():
    assert D.pares_padrao(CBERS, ['2023-06-01'], False) == {'antes': '2023-05-30', 'depois': '2023-06-01'}


def test_pares_padrao_varios_alertas_e_fora_do_periodo():
    assert D.pares_padrao(S2, ['2022-12-15', '2023-06-01'], True) == {'antes': '2023-01-01', 'depois': '2023-07-01'}
    assert D.pares_padrao(S2, ['2022-12-15', '2023-12-01'], True) == {'antes': '2022-07-01', 'depois': '2023-01-01'}
    assert D.pares_padrao(S2, ['2019-03-10'], True) == {'antes': '2022-07-01', 'depois': '2023-10-01'}
    assert D.pares_padrao(CBERS, ['2024-01-01'], False) == {'antes': '2023-04-02', 'depois': '2023-07-04'}
    assert D.par_que_cerca(CBERS, '2023-04-01', False) is None


def test_pares_padrao_sem_imagem_ou_uma_so():
    assert D.pares_padrao([], ['2023-06-01'], True) is None
    assert D.pares_padrao(S2[:1], [], True) == {'antes': '2022-07-01', 'depois': '2022-07-01'}


def test_trimestre_de_outubro_termina_em_janeiro():
    assert D.par_que_cerca(S2, '2023-01-01', True) == {'antes': '2022-10-01', 'depois': '2023-01-01'}
    assert D.par_que_cerca(S2, '2022-12-31', True) == {'antes': '2022-07-01', 'depois': '2023-01-01'}


def _alerta_mb(id_: str, detectado_em: str, caso: str) -> dict:
    foto = {'data': detectado_em, 'url': f'https://image.alerta.mapbiomas.org/{id_}.png', 'constelacao': 'PlanetScope'}
    return {'id': id_, 'alerta': id_, 'detectado_em': detectado_em, 'limites': [-48, -18, -47.9, -17.9] if caso == 'mapa' else None,
            'antes': None if caso == 'sem-imagem' else foto, 'depois': None if caso == 'sem-imagem' else foto}


def test_casos_e_alerta_sugerido_do_mapbiomas():
    assert D.caso_mapbiomas(_alerta_mb('1', '2023-06-01', 'mapa')) == 'mapa'
    assert D.caso_mapbiomas(_alerta_mb('2', '2023-06-01', 'sem-mapa')) == 'sem-mapa'
    assert D.caso_mapbiomas(_alerta_mb('3', '2023-06-01', 'sem-imagem')) == 'sem-imagem'
    assert D.caso_mapbiomas({**_alerta_mb('4', '2023-06-01', 'mapa'), 'antes': None}) == 'mapa'
    a = lambda *casos: [_alerta_mb(str(n), f'202{n}-01-01', c) for n, c in enumerate(casos, 1)]  # noqa: E731
    assert D.alerta_padrao(a('mapa', 'sem-mapa', 'sem-imagem')) == '1'
    assert D.alerta_padrao(a('sem-imagem', 'sem-mapa', 'sem-imagem')) == '2'
    assert D.alerta_padrao(a('sem-imagem', 'sem-imagem')) == '2'
    assert D.alerta_padrao([]) is None


def test_fontes_da_deteccao():
    assert D.fontes_da_deteccao('2023-02-28') == ['sentinel2']
    assert D.fontes_da_deteccao('2023-03-01') == ['sentinel2', 'cbers4a']


def test_listagem_mapbiomas_traz_caso_fontes_e_sugestao(api, inpe, monkeypatch):
    opcoes = [_alerta_mb('1', '2021-05-01', 'mapa'), _alerta_mb('2', '2024-02-01', 'sem-imagem')]
    monkeypatch.setattr(I, 'opcoes_mapbiomas', lambda cod, alertas: [dict(o) for o in opcoes])
    d = api.get(f'/car/{COD}/imagens', params={'fonte': 'mapbiomas'}).json()
    assert [(o['id'], o['caso'], o['fontes_alternativas']) for o in d['opcoes']] == [
        ('1', 'mapa', ['sentinel2']), ('2', 'sem-imagem', ['sentinel2', 'cbers4a'])]
    assert d['sugestao'] == {'alerta': '1'}
