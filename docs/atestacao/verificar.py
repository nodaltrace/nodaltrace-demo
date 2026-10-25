#!/usr/bin/env python3
"""Verificador independente de um relatório do NodalTrace registrado na Solana (docs/atestacao/CONTRATO.md).

    pip install rfc8785
    python3 verificar.py relatorio-NT-2026-000001.json --autoridade <endereço publicado pelo NodalTrace>

Lê o documento do relatório (GET /relatorios/{id}/documento) ou uma prova parcial (POST /relatorios/{id}/prova),
recalcula a raiz de Merkle, deriva do endereço da autoridade a credencial NODALTRACE, o schema NT_RELATORIO e a conta
do relatório no Solana Attestation Service, lê a conta direto do RPC e confere campo a campo. Não fala com nenhum
servidor do NodalTrace. Só a biblioteca padrão do Python e o rfc8785 (JCS, RFC 8785).

Sai com 0 se tudo confere, 1 se algo diverge e 2 se o arquivo não é um relatório.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
import urllib.request
from datetime import datetime, timezone

import rfc8785

PROGRAMA_SAS = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG'
NOME_CREDENCIAL = 'NODALTRACE'
NOME_SCHEMA = 'NT_RELATORIO'
VERSAO_SCHEMA = 1
FORMATO = 'NT_RELATORIO/1'
FORMATO_PROVA = 'NT_RELATORIO_PROVA/1'
RPC_PADRAO = 'https://api.devnet.solana.com'

# --- base58 --------------------------------------------------------------------------------------------

_B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, 'big')
    s = ''
    while n:
        n, r = divmod(n, 58)
        s = _B58[r] + s
    return '1' * (len(b) - len(b.lstrip(b'\0'))) + s


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 58 + _B58.index(c)
    corpo = n.to_bytes((n.bit_length() + 7) // 8, 'big') if n else b''
    return b'\0' * (len(s) - len(s.lstrip('1'))) + corpo


# --- endereços derivados (PDA) ----------------------------------------------------------------------------

_P = 2 ** 255 - 19
_D = -121665 * pow(121666, _P - 2, _P) % _P


def na_curva(b: bytes) -> bool:
    """Os 32 bytes são um ponto da ed25519 (como CompressedEdwardsY::decompress do curve25519-dalek)? Uma PDA nunca é."""
    y = int.from_bytes(b, 'little') & ((1 << 255) - 1)
    y2 = y * y % _P
    x2 = (y2 - 1) * pow((_D * y2 + 1) % _P, _P - 2, _P) % _P
    return x2 == 0 or pow(x2, (_P - 1) // 2, _P) == 1


def pda(sementes: list[bytes], programa: bytes) -> bytes:
    """find_program_address: o primeiro bump, de 255 para baixo, cujo hash não cai na curva."""
    for bump in range(255, -1, -1):
        h = hashlib.sha256(b''.join(sementes) + bytes([bump]) + programa + b'ProgramDerivedAddress').digest()
        if not na_curva(h):
            return h
    raise ValueError('sem PDA para estas sementes')


def contas(autoridade: str, serie: str, numero: int) -> dict[str, bytes]:
    """A credencial NODALTRACE da autoridade, o schema NT_RELATORIO v1 e a conta do relatório (CONTRATO §4)."""
    prog = b58decode(PROGRAMA_SAS)
    cred = pda([b'credential', b58decode(autoridade), NOME_CREDENCIAL.encode()], prog)
    schema = pda([b'schema', cred, NOME_SCHEMA.encode(), bytes([VERSAO_SCHEMA])], prog)
    nonce = hashlib.sha256(f'{NOME_SCHEMA}:{serie}:{numero}'.encode()).digest()
    return {'credencial': cred, 'schema': schema, 'nonce': nonce, 'conta': pda([b'attestation', cred, schema, nonce], prog)}


# --- documento e árvore de Merkle --------------------------------------------------------------------------

def folha(item: dict) -> bytes:
    return hashlib.sha256(b'\x00' + rfc8785.dumps(item)).digest()


def no(a: bytes, b: bytes) -> bytes:
    return hashlib.sha256(b'\x01' + a + b).digest()


def raiz(itens: list[dict]) -> bytes:
    nivel = [folha(i) for i in sorted(itens, key=lambda i: (i['tipo'].encode(), i['id'].encode()))]
    while len(nivel) > 1:
        nivel = [no(nivel[k], nivel[k + 1]) if k + 1 < len(nivel) else nivel[k] for k in range(0, len(nivel), 2)]
    return nivel[0]


def raiz_pela_prova(item: dict, passos: list[dict]) -> bytes:
    h = folha(item)
    for p in passos:
        irmao = bytes.fromhex(p['hash'])
        h = no(irmao, h) if p['lado'] == 'esquerda' else no(h, irmao)
    return h


def ler_arquivo(obj: dict) -> tuple[list[dict], dict, bytes, list[str]]:
    """(folhas, cabeçalho, raiz recalculada, problemas do arquivo). ValueError: não é um relatório."""
    itens = obj.get('itens')
    if not isinstance(itens, list) or not itens or not all(isinstance(i, dict) and isinstance(i.get('tipo'), str) and isinstance(i.get('id'), str) for i in itens):
        raise ValueError('o arquivo não tem as folhas ("itens") de um relatório')
    cab = next((i for i in itens if i['tipo'] == 'cabecalho'), None)
    if not cab or cab.get('formato') != FORMATO:
        raise ValueError(f'sem cabeçalho no formato {FORMATO}')
    problemas = []
    if obj.get('formato') is None:
        return itens, cab, raiz(itens), problemas
    if obj.get('formato') != FORMATO_PROVA:
        raise ValueError(f'formato desconhecido: {obj.get("formato")}')
    raizes = {raiz_pela_prova(i, obj['provas'][f'{i["tipo"]}:{i["id"]}']) for i in itens}
    if len(raizes) != 1:
        problemas.append('as folhas da prova levam a raízes diferentes: alguma foi alterada')
    return itens, cab, next(iter(raizes)), problemas


def campos_esperados(cab: dict, raiz_: bytes) -> dict:
    emitido = datetime.fromisoformat(cab['emitido_em'].replace('Z', '+00:00'))
    return {'root': raiz_.hex(), 'series': cab['serie'], 'number': cab['numero'], 'issued_at': int(emitido.timestamp()),
            'ruleset': cab['regras']['versao'], 'replaces': cab['substitui']['numero'] if cab.get('substitui') else 0}


# --- conta na rede -----------------------------------------------------------------------------------------

class Leitor:
    def __init__(self, dados: bytes):
        self.d, self.o = dados, 0

    def ler(self, n: int) -> bytes:
        if self.o + n > len(self.d):
            raise ValueError('dados curtos')
        b = self.d[self.o:self.o + n]
        self.o += n
        return b

    def u32(self) -> int:
        return int.from_bytes(self.ler(4), 'little')

    def vec(self) -> bytes:
        return self.ler(self.u32())


def ler_atestacao(dados: bytes) -> dict:
    """Conta Attestation do SAS: discriminador, nonce, credencial, schema, dados, assinante, validade, token."""
    r = Leitor(dados)
    conta = {'discriminador': r.ler(1)[0], 'nonce': r.ler(32), 'credencial': r.ler(32), 'schema': r.ler(32), 'dados': r.vec(),
             'assinante': r.ler(32), 'validade': int.from_bytes(r.ler(8), 'little', signed=True), 'token': r.ler(32)}
    if r.o != len(dados):
        raise ValueError('bytes sobrando na conta')
    return conta


def ler_campos(dados: bytes) -> dict:
    """Os dados no layout do schema NT_RELATORIO (CONTRATO §4)."""
    r = Leitor(dados)
    campos = {'root': r.vec().hex(), 'series': r.vec().decode(), 'number': r.u32(),
              'issued_at': int.from_bytes(r.ler(8), 'little', signed=True), 'ruleset': r.vec().decode(), 'replaces': r.u32()}
    if r.o != len(dados):
        raise ValueError('bytes sobrando nos dados')
    return campos


def rpc(url: str, metodo: str, params: list):
    corpo = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': metodo, 'params': params}).encode()
    pedido = urllib.request.Request(url, corpo, {'Content-Type': 'application/json'})
    with urllib.request.urlopen(pedido, timeout=30) as r:
        resposta = json.load(r)
    if 'error' in resposta:
        raise RuntimeError(f'{metodo}: {resposta["error"]}')
    return resposta['result']


# --- verificação -------------------------------------------------------------------------------------------

# Acima disto (em segundos) entre a emissão declarada e o bloco do registro, o verificador avisa.
ATRASO_MAXIMO_S = 600


def duracao(s: int) -> str:
    if s < 3600:
        return f'{s // 60} min'
    if s < 86400:
        h, m = s // 3600, s % 3600 // 60
        return f'{h} h {m} min' if m else f'{h} h'
    d = s // 86400
    return '1 dia' if d == 1 else f'{d} dias'


def aviso_de_atraso(atraso: int) -> str | None:
    """O aviso para um bloco longe da emissão declarada (atraso = hora do bloco − issued_at, em segundos): a rede garante
    só que o documento existia no bloco; antes dele, vale a data que o NodalTrace declara."""
    if atraso > ATRASO_MAXIMO_S:
        return (f'o registro saiu {duracao(atraso)} depois da emissão declarada: a rede garante que o documento existia no '
                'bloco; antes dele, vale só a data que o NodalTrace declara')
    if atraso < -ATRASO_MAXIMO_S:
        return f'a emissão declarada é {duracao(-atraso)} depois do bloco: o relógio do servidor do NodalTrace estava adiantado'
    return None


def verificar(obj: dict, autoridade: str, url: str, saida=print) -> bool:
    itens, cab, raiz_, problemas = ler_arquivo(obj)
    esperado = campos_esperados(cab, raiz_)
    endereco = contas(autoridade, cab['serie'], cab['numero'])
    ok = not problemas
    marca = lambda bom: '✔' if bom else '✘'  # noqa: E731
    saida(f'Relatório {cab["relatorio"]} · número {cab["numero"]} da série {cab["serie"]} · emitido em {cab["emitido_em"]}')
    saida(f'{"Prova parcial" if obj.get("formato") else "Documento"} com {sum(i["tipo"] == "imovel" for i in itens)} imóvel(is); raiz {raiz_.hex()}')
    for p in problemas:
        saida(f'✘ {p}')
    saida(f'Credencial {b58encode(endereco["credencial"])} · schema {b58encode(endereco["schema"])}')
    saida(f'Conta do relatório {b58encode(endereco["conta"])} ({url})')

    info = rpc(url, 'getAccountInfo', [b58encode(endereco['conta']), {'encoding': 'base64', 'commitment': 'confirmed'}])['value']
    if not info:
        saida('✘ a conta do relatório não existe na rede')
        return False
    if info['owner'] != PROGRAMA_SAS:
        saida(f'✘ a conta não é do programa SAS ({info["owner"]})')
        return False
    try:
        conta = ler_atestacao(base64.b64decode(info['data'][0]))
        lido = ler_campos(conta['dados'])
    except ValueError as e:
        saida(f'✘ a conta não segue o layout: {e}')
        return False
    for rotulo, bom in [('discriminador de atestação', conta['discriminador'] == 2),
                        ('credencial e schema esperados', (conta['credencial'], conta['schema']) == (endereco['credencial'], endereco['schema'])),
                        ('nonce da série e do número', conta['nonce'] == endereco['nonce']),
                        ('registro permanente (sem validade)', conta['validade'] == 0)]:
        saida(f'{marca(bom)} {rotulo}')
        ok &= bom
    for campo, valor in esperado.items():
        bom = lido[campo] == valor
        saida(f'{marca(bom)} {campo}: no arquivo {valor} · na rede {lido[campo]}')
        ok &= bom
    saida(f'  assinado por {b58encode(conta["assinante"])}')
    try:
        assinaturas = rpc(url, 'getSignaturesForAddress', [b58encode(endereco['conta']), {'commitment': 'confirmed'}])
        if assinaturas:
            primeira = assinaturas[-1]
            quando = datetime.fromtimestamp(primeira['blockTime'], timezone.utc).isoformat() if primeira.get('blockTime') else '?'
            saida(f'  criada na transação {primeira["signature"]} (slot {primeira["slot"]}, bloco de {quando})')
            aviso = primeira.get('blockTime') and aviso_de_atraso(primeira['blockTime'] - lido['issued_at'])
            if aviso:
                saida(f'  ! {aviso}')
    except Exception as e:  # o histórico é informativo: a conta já basta para conferir o conteúdo
        saida(f'  (sem o histórico da conta: {e})')
    saida('CONFERE: o arquivo é o que foi registrado na Solana.' if ok else 'NÃO CONFERE.')
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('arquivo', help='o documento do relatório ou uma prova parcial (.json)')
    ap.add_argument('--autoridade', required=True, help='o endereço da autoridade publicado pelo NodalTrace')
    ap.add_argument('--rpc', default=RPC_PADRAO, help=f'RPC da Solana (padrão {RPC_PADRAO})')
    a = ap.parse_args()
    with open(a.arquivo, encoding='utf-8') as f:
        obj = json.load(f)
    try:
        return 0 if verificar(obj, a.autoridade, a.rpc) else 1
    except ValueError as e:
        print(f'não é um relatório do NodalTrace: {e}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
