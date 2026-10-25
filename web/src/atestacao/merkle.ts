/**
 * Árvore de Merkle do documento do relatório (docs/atestacao/CONTRATO.md §3). Puro: sem rede nem DOM.
 *
 * - Ordem das folhas: (tipo, id), comparando os bytes UTF-8.
 * - Folha: sha256(0x00 ‖ JCS(item)). Nó: sha256(0x01 ‖ esquerda ‖ direita).
 * - Em cada nível, pares (0,1), (2,3)…; o nó ímpar do fim sobe sem hash. Lista vazia: erro.
 */
import canonicalize from 'canonicalize'
import { paraHex, sha256Bytes } from '../sha256'

export interface Item {
  tipo: string
  id: string
  [campo: string]: unknown
}

const utf8 = new TextEncoder()

export const deHex = (hex: string): Uint8Array => {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error('Invalid hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
export { paraHex }

const concat = (...partes: Uint8Array[]) => {
  const out = new Uint8Array(partes.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of partes) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Comparação de bytes (sem sinal), lexicográfica. */
export function compararBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

/** Itens na ordem das folhas: (tipo, id) pelos bytes UTF-8, não pelas unidades UTF-16 do JavaScript. */
export function ordenar<T extends Item>(itens: readonly T[]): T[] {
  const chave = new Map(itens.map((i) => [i, [utf8.encode(i.tipo), utf8.encode(i.id)] as const]))
  return [...itens].sort((a, b) => {
    const [ta, ia] = chave.get(a)!
    const [tb, ib] = chave.get(b)!
    return compararBytes(ta, tb) || compararBytes(ia, ib)
  })
}

/** RFC 8785. */
export function jcs(valor: unknown): string {
  const s = canonicalize(valor)
  if (s === undefined) throw new Error('Value has no JSON representation')
  return s
}

export const folha = (item: Item): Uint8Array => sha256Bytes(concat(Uint8Array.of(0x00), utf8.encode(jcs(item))))

export const no = (esquerda: Uint8Array, direita: Uint8Array): Uint8Array => sha256Bytes(concat(Uint8Array.of(0x01), esquerda, direita))

/** Raiz a partir das folhas já na ordem. */
export function raiz(folhas: readonly Uint8Array[]): Uint8Array {
  if (!folhas.length) throw new Error('Merkle tree without leaves')
  let nivel = [...folhas]
  while (nivel.length > 1) {
    const prox: Uint8Array[] = []
    for (let i = 0; i < nivel.length; i += 2) prox.push(i + 1 < nivel.length ? no(nivel[i], nivel[i + 1]) : nivel[i])
    nivel = prox
  }
  return nivel[0]
}

export interface Arvore<T extends Item = Item> {
  /** Itens na ordem das folhas. */
  itens: T[]
  folhas: Uint8Array[]
  raiz: Uint8Array
}

export function arvore<T extends Item>(itens: readonly T[]): Arvore<T> {
  const ordenados = ordenar(itens)
  const folhas = ordenados.map(folha)
  return { itens: ordenados, folhas, raiz: raiz(folhas) }
}

export interface Passo {
  lado: 'esquerda' | 'direita'
  hash: string
}

/** Sobe da folha do item até a raiz pelos irmãos da prova de inclusão (o nó ímpar que sobe sem hash não gera passo). */
export function raizPelaProva(item: Item, passos: readonly Passo[]): Uint8Array {
  let h = folha(item)
  for (const p of passos) {
    if (p?.lado !== 'esquerda' && p?.lado !== 'direita') throw new Error('Proof step without a side')
    const irmao = deHex(String(p.hash))
    if (irmao.length !== 32) throw new Error('Proof step with an invalid hash')
    h = p.lado === 'esquerda' ? no(irmao, h) : no(h, irmao)
  }
  return h
}
