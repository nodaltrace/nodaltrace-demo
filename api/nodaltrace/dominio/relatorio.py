"""O documento do relatório de análise e o registro dele na Solana (docs/atestacao/CONTRATO.md). Puro: sem banco.

O documento é a lista das folhas da árvore de Merkle, guardada e baixada como `{"itens": [...]}` em JCS: um `cabecalho`
(número, série, emissão, regras, bases, análises, a correção), um `resumo` (o veredito e a contagem) e um `imovel` por
código do CAR, na ordem do pedido. Cada `imovel` e o `resumo` levam um sal aleatório: sem ele, quem tem os hashes vizinhos
de uma prova poderia adivinhar um imóvel escondido a partir dos dados públicos do SICAR. A raiz da árvore é o que vai
para a rede, com a série, o número, o instante da emissão, a versão das regras e o número do relatório substituído.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from typing import Any

from . import merkle
from .conformidade import VERSAO_REGRAS, regras_em_vigor
from .renovabio import AREA_MIN_SUPRESSAO_HA, COBERTURA_MAPBIOMAS, regras as regras_renovabio

FORMATO = 'NT_RELATORIO/1'
FORMATO_PROVA = 'NT_RELATORIO_PROVA/1'
#: Schema do Solana Attestation Service e prefixo do nonce.
SCHEMA = 'NT_RELATORIO'


def _json(v: Any) -> Any:
    """Datas em ISO 8601; o resto como está (só tipos do JSON)."""
    if isinstance(v, dict):
        return {k: _json(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_json(x) for x in v]
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    return v


# --- regras ---------------------------------------------------------------------------------------

def parametros_das_regras() -> dict:
    """Os parâmetros das regras de decisão em vigor, em JSON: os de dominio/conformidade.py e os do RenovaBio (o hash do
    YAML identifica o arquivo inteiro). Entram no cabeçalho de cada relatório."""
    rb = regras_renovabio()
    return _json({
        **regras_em_vigor(),
        'renovabio': {'versao': rb.versao, 'minuta': rb.minuta, 'hash': rb.hash, 'area_min_supressao_ha': AREA_MIN_SUPRESSAO_HA,
                      'cobertura_mapbiomas': COBERTURA_MAPBIOMAS},
    })


def hash_parametros(parametros: dict) -> str:
    """SHA-256 do JCS dos parâmetros: o que regras/versoes.json registra para cada versão."""
    return hashlib.sha256(merkle.jcs(parametros)).hexdigest()


def regras_do_relatorio() -> dict:
    return {'versao': VERSAO_REGRAS, 'parametros': parametros_das_regras()}


# --- documento --------------------------------------------------------------------------------------

def texto(itens: list[dict]) -> str:
    """O documento guardado: `{"itens": [...]}` em JCS (RFC 8785), na ordem dada (a árvore ordena as folhas sozinha)."""
    return merkle.jcs({'itens': itens}).decode()


def ler(documento: str) -> list[dict]:
    return json.loads(documento)['itens']


def raiz(itens: list[dict]) -> str:
    return merkle.raiz(itens).hex()


def cabecalho(itens: list[dict]) -> dict:
    return next(i for i in itens if i['tipo'] == 'cabecalho')


def visao(itens: list[dict]) -> dict:
    """O relatório para ler: o cabeçalho, o veredito e os imóveis na ordem do pedido, sem os sais."""
    cab = cabecalho(itens)
    res = next(i for i in itens if i['tipo'] == 'resumo')
    return {
        'id': cab['relatorio'], 'serie': cab['serie'], 'numero': cab['numero'], 'emitido_em': cab['emitido_em'],
        'emissor': cab['emissor'], 'regras': cab['regras'], 'bases': cab['bases'], 'analises': cab['analises'],
        'substitui': cab['substitui'], 'status': res['status'], 'resumo': res['contagem'],
        'imoveis': [{'cod_imovel': i['id'], **{k: v for k, v in i.items() if k not in ('tipo', 'id', 'sal')}}
                    for i in itens if i['tipo'] == 'imovel'],
    }


def prova(itens: list[dict], cods: list[str], com_resumo: bool = False) -> dict:
    """Pacote de prova parcial: o cabeçalho (sempre), os imóveis pedidos (e o resumo, se pedido), cada um com a prova de
    inclusão até a raiz. Quem o recebe confere tudo contra a rede sem ver os outros imóveis. Código fora do relatório:
    KeyError."""
    presentes = {i['id'] for i in itens if i['tipo'] == 'imovel'}
    if faltam := [c for c in cods if c not in presentes]:
        raise KeyError(', '.join(faltam))
    chaves = [('cabecalho', 'cabecalho'), *([('resumo', 'resumo')] if com_resumo else []), *(('imovel', c) for c in dict.fromkeys(cods))]
    por_chave = {(i['tipo'], i['id']): i for i in itens}
    return {
        'formato': FORMATO_PROVA,
        'relatorio': cabecalho(itens)['relatorio'],
        'raiz': raiz(itens),
        'itens': [por_chave[k] for k in chaves],
        'provas': {f'{t}:{i}': merkle.prova(itens, t, i) for t, i in chaves},
    }


# --- registro na rede --------------------------------------------------------------------------------

def nonce(serie: str, numero: int) -> str:
    """Nonce da conta do relatório no SAS, em hex: sha256(utf8("NT_RELATORIO:" + série + ":" + número)). Uma conta por
    (série, número): outro documento com o mesmo número não cabe na rede."""
    return hashlib.sha256(f'{SCHEMA}:{serie}:{numero}'.encode()).hexdigest()


def campos_na_rede(itens: list[dict]) -> dict:
    """Os campos do schema NT_RELATORIO para o attestor (CONTRATO §4)."""
    cab = cabecalho(itens)
    return {
        'root': raiz(itens),
        'series': cab['serie'],
        'number': cab['numero'],
        'issued_at': int(datetime.fromisoformat(cab['emitido_em']).timestamp()),
        'ruleset': cab['regras']['versao'],
        'replaces': cab['substitui']['numero'] if cab['substitui'] else 0,
    }
