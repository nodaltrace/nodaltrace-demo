"""Árvore de Merkle dos manifestos de atestação (docs/atestacao/CONTRATO.md §3).

Folhas: os itens ordenados por (tipo, id) pelos bytes UTF-8; folha = sha256(0x00 ‖ JCS(item)); nó = sha256(0x01 ‖ e ‖ d);
em cada nível, um nó ímpar no fim sobe sem hash."""

from __future__ import annotations

import hashlib

import rfc8785


def jcs(obj) -> bytes:
    """Canonicalização RFC 8785 (JCS)."""
    return rfc8785.dumps(obj)


def folha(item: dict) -> bytes:
    return hashlib.sha256(b'\x00' + jcs(item)).digest()


def no(a: bytes, b: bytes) -> bytes:
    return hashlib.sha256(b'\x01' + a + b).digest()


def _chave(item: dict) -> tuple[bytes, bytes]:
    return item['tipo'].encode(), item['id'].encode()


def ordenar(itens: list[dict]) -> list[dict]:
    """Os itens na ordem das folhas."""
    return sorted(itens, key=_chave)


def _niveis(itens: list[dict]) -> list[list[bytes]]:
    if not itens:
        raise ValueError('manifesto sem itens')
    nivel = [folha(i) for i in ordenar(itens)]
    niveis = [nivel]
    while len(nivel) > 1:
        nivel = [no(nivel[k], nivel[k + 1]) if k + 1 < len(nivel) else nivel[k] for k in range(0, len(nivel), 2)]
        niveis.append(nivel)
    return niveis


def raiz(itens: list[dict]) -> bytes:
    return _niveis(itens)[-1][0]


def prova(itens: list[dict], tipo: str, id: str) -> list[dict]:
    """Prova de inclusão do item (tipo, id): os irmãos da folha até a raiz, cada um com o lado em que fica
    (`esquerda` ou `direita`) e o hash em hex. O nó ímpar que sobe sem hash não gera passo."""
    ordem = [_chave(i) for i in ordenar(itens)]
    k = ordem.index((tipo.encode(), id.encode()))
    passos = []
    for nivel in _niveis(itens)[:-1]:
        irmao = k ^ 1
        if irmao < len(nivel):
            passos.append({'lado': 'esquerda' if irmao < k else 'direita', 'hash': nivel[irmao].hex()})
        k //= 2
    return passos


def verificar_prova(item: dict, passos: list[dict], raiz_hex: str) -> bool:
    h = folha(item)
    for p in passos:
        irmao = bytes.fromhex(p['hash'])
        h = no(irmao, h) if p['lado'] == 'esquerda' else no(h, irmao)
    return h.hex() == raiz_hex
