from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Response

from ..banco import pool
from ..consultas import alertas, imoveis
from ..dominio.imagens import ID_DATA, RESOLUCAO_M
from ..erros import NaoEncontrado
from ..modelos.imagens import Imagens
from ..servicos import imagens
from ..servicos.imagens import Fonte, FonteInpe

router = APIRouter(prefix='/car', tags=['Imagens'])


def _imovel(cod: str, com_alertas: bool = False) -> dict:
    """Retângulo e contorno da versão que vale do imóvel e, se pedido, os alertas dele. A conexão volta ao pool antes
    das fontes externas, que podem levar segundos."""
    with pool.connection() as con:
        im = imoveis.recorte(con, cod)
        if im is None:
            raise NaoEncontrado(f'CAR {cod} not found')
        if com_alertas:
            im['alertas'] = alertas.para_imagens(con, cod)
    return im


def _cabecalhos(fonte: FonteInpe, res: float, completa: bool) -> dict[str, str]:
    """Cache e resolução no terreno (nunca melhor que a da fonte: o recorte arredonda o número de pixels para cima).
    `X-Reducao` só quando a resolução é pior que a da fonte: `defeito-inpe` (tile corrompido, sem cache) ou `tamanho`
    (o imóvel passa de LADO_MAX px no lado maior)."""
    nominal = RESOLUCAO_M[fonte]
    c = {'Cache-Control': 'public, max-age=31536000, immutable' if completa else 'no-store',
         'X-Resolucao-Metros': f'{round(max(res, nominal), 1):g}'}
    if not completa:
        c['X-Reducao'] = 'defeito-inpe'
    elif res > nominal * 1.001:
        c['X-Reducao'] = 'tamanho'
    return c


@router.get('/{cod_imovel}/imagens', response_model=Imagens)
def listagem(cod_imovel: str, fonte: Fonte, deteccao: date | None = None) -> dict:
    """Datas de imagem disponíveis para o imóvel, por fonte, e as sugeridas para comparar. `versao` muda com o retângulo
    do recorte: o frontend acrescenta `?v={versao}` à URL da imagem, que tem cache imutável no navegador.
    `deteccao` (fontes do INPE): sugere o par em volta desta data, a de um alerta do MapBiomas sem imagem própria, em vez
    das detecções dos alertas do imóvel."""
    return imagens.listagem(cod_imovel, _imovel(cod_imovel, com_alertas=True), fonte, deteccao)


@router.get('/{cod_imovel}/imagens/{fonte}/{id_opcao}', response_class=Response,
            responses={200: {'content': {'image/webp': {}, 'image/jpeg': {}}}})
def imagem(cod_imovel: str, fonte: FonteInpe, id_opcao: str) -> Response:
    """Recorte da imagem de uma data, em EPSG:3857, com os cantos em `limites` da listagem."""
    im = _imovel(cod_imovel)
    if not ID_DATA.fullmatch(id_opcao):
        raise NaoEncontrado(f'option {id_opcao[:40]} does not exist')
    conteudo, res, completa = imagens.imagem(cod_imovel, im, fonte, id_opcao)
    return Response(conteudo, media_type=imagens.formato()[2], headers=_cabecalhos(fonte, res, completa))
