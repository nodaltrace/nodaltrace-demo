"""Versão das regras de decisão (VERSAO_REGRAS) contra o registro das versões (api/nodaltrace/regras/versoes.json)."""

import json
from pathlib import Path

from nodaltrace.dominio.conformidade import VERSAO_REGRAS
from nodaltrace.dominio.relatorio import hash_parametros, parametros_das_regras

VERSOES = json.loads((Path(__file__).resolve().parents[1] / 'nodaltrace/regras/versoes.json').read_text())['versoes']


def test_parametros_de_hoje_sao_os_da_versao_em_vigor():
    """Falhou? Um parâmetro de regra mudou: acrescente uma versão em regras/versoes.json (com o hash abaixo e o que mudou)
    e suba VERSAO_REGRAS. Os relatórios já emitidos continuam dizendo a versão com que foram feitos."""
    registrada = next((v for v in VERSOES if v['versao'] == VERSAO_REGRAS), None)
    assert registrada, f'VERSAO_REGRAS {VERSAO_REGRAS} sem registro em regras/versoes.json'
    assert hash_parametros(parametros_das_regras()) == registrada['hash_parametros']


def test_versoes_unicas_e_a_em_vigor_e_a_ultima():
    nomes = [v['versao'] for v in VERSOES]
    assert len(nomes) == len(set(nomes))
    assert nomes[-1] == VERSAO_REGRAS
    assert len({v['hash_parametros'] for v in VERSOES}) == len(VERSOES)


def test_mudar_um_parametro_muda_o_hash():
    p = parametros_das_regras()
    assert hash_parametros({**p, 'area_min_alerta_ha': 2.0}) != hash_parametros(p)
