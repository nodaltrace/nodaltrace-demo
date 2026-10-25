"""Regras que existem em mais de um lugar porque a API e o banco rodam separados. Este teste falha se as cópias
divergirem. Roda no host: python3 -m unittest discover -s tests"""

import ast
import re
import unittest
from datetime import date
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
CONFORMIDADE = RAIZ / 'api/nodaltrace/dominio/conformidade.py'
#: Funções do banco que separam os alertas depois do corte da EUDR: as de tile (`pos_corte`, que o mapa pinta como não
#: conforme) e o resumo dos alertas na ficha de cada imóvel (ref.car_resumo).
FUNCOES_COM_CORTE = ('alerta_tiles', 'car_alerta_tiles', 'resumir_alertas')


def _corte_da_api() -> date:
    """CORTE_EUDR = date(AAAA, M, D) em dominio/conformidade.py, lido sem importar o pacote."""
    for no in ast.parse(CONFORMIDADE.read_text()).body:
        if isinstance(no, ast.Assign) and getattr(no.targets[0], 'id', None) == 'CORTE_EUDR':
            return date(*(a.value for a in no.value.args))
    raise AssertionError('CORTE_EUDR não encontrado')


def _definicao_vigente(funcao: str) -> str:
    """O corpo da função na última migração que a (re)cria: é o que está no banco depois do `migrar`."""
    vigente = None
    for arquivo in sorted((RAIZ / 'db').glob('*.sql')):
        texto = arquivo.read_text()
        for m in re.finditer(rf'CREATE OR REPLACE FUNCTION ref\.{funcao}\b(.*?)\$\$;', texto, re.S):
            vigente = m.group(1)
    if vigente is None:
        raise AssertionError(f'ref.{funcao} não é criada por nenhuma migração')
    return vigente


class Paridade(unittest.TestCase):
    def test_corte_da_eudr_no_banco_e_o_da_api(self):
        corte = _corte_da_api()
        for funcao in FUNCOES_COM_CORTE:
            datas = {date.fromisoformat(d) for d in re.findall(r"date '(\d{4}-\d{2}-\d{2})'", _definicao_vigente(funcao))}
            self.assertEqual(datas, {corte}, f'ref.{funcao}: crie uma migração nova com o corte da API ({corte})')


if __name__ == '__main__':
    unittest.main()
