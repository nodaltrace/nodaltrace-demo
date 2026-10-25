"""Árvore de Merkle da atestação (api/nodaltrace/dominio/merkle.py) contra os vetores do contrato
(docs/atestacao/vetores.json), os mesmos que o frontend confere em web/src/atestacao/merkle.test.ts."""

import json
import os
from pathlib import Path

import pytest

from nodaltrace.dominio import merkle


def _vetores() -> dict:
    """No container o repositório não está montado, mas docs/ sim (em /docs); no host, ../docs a partir de api/."""
    for p in [os.environ.get('NT_VETORES'), '/docs/atestacao/vetores.json', Path(__file__).resolve().parents[2] / 'docs/atestacao/vetores.json']:
        if p and Path(p).is_file():
            return json.loads(Path(p).read_text())
    pytest.skip('docs/atestacao/vetores.json não encontrado (monte ./docs em /docs ou defina NT_VETORES)')


def test_vetores_do_contrato():
    casos = _vetores()['casos']
    assert casos
    for c in casos:
        ordem = merkle.ordenar(c['itens'])
        assert [[i['tipo'], i['id']] for i in ordem] == c['ordem'], c['nome']
        assert [merkle.jcs(i).decode() for i in ordem] == c['jcs'], c['nome']
        assert [merkle.folha(i).hex() for i in ordem] == c['folhas'], c['nome']
        assert merkle.raiz(c['itens']).hex() == c['raiz'], c['nome']


def test_lista_vazia_e_erro():
    with pytest.raises(ValueError):
        merkle.raiz([])


def test_prova_de_inclusao_ida_e_volta():
    for c in _vetores()['casos']:
        for item in c['itens']:
            passos = merkle.prova(c['itens'], item['tipo'], item['id'])
            assert merkle.verificar_prova(item, passos, c['raiz'])
            assert not merkle.verificar_prova({**item, 'id': item['id'] + 'x'}, passos, c['raiz'])
