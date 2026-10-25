import { describe, expect, it } from 'vitest'
import vetores from '../../../docs/atestacao/vetores.json'
import { arvore, folha, jcs, no, ordenar, paraHex, raiz, raizPelaProva, type Item, type Passo } from './merkle'
import { sha256 } from '../sha256'

describe('vetores do CONTRATO §3', () => {
  for (const caso of vetores.casos) {
    it(caso.nome, () => {
      const itens = caso.itens as Item[]
      const ordenados = ordenar(itens)
      expect(ordenados.map((i) => [i.tipo, i.id])).toEqual(caso.ordem)
      expect(ordenados.map(jcs)).toEqual(caso.jcs)
      expect(ordenados.map((i) => paraHex(folha(i)))).toEqual(caso.folhas)
      expect(paraHex(arvore(itens).raiz)).toBe(caso.raiz)
      // A raiz não depende da ordem em que as folhas estão guardadas.
      expect(paraHex(arvore([...itens].reverse()).raiz)).toBe(caso.raiz)
    })
  }
})

describe('árvore', () => {
  const h = (s: string) => Uint8Array.from({ length: 32 }, (_, i) => s.charCodeAt(0) + i)
  it('nó ímpar sobe sem hash', () => {
    const [a, b, c] = [h('a'), h('b'), h('c')]
    expect(paraHex(raiz([a, b, c]))).toBe(paraHex(no(no(a, b), c)))
    expect(paraHex(raiz([a]))).toBe(paraHex(a))
  })
  it('lista vazia é erro', () => expect(() => raiz([])).toThrow())
  it('ordena pelos bytes UTF-8, não por UTF-16', () => {
    // U+FF5E (ef bd 9e) vem antes de U+1F600 (f0 9f 98 80) em UTF-8; em UTF-16, depois (ff5e > d83d).
    const itens: Item[] = [{ tipo: 'x', id: '😀' }, { tipo: 'x', id: '～' }]
    expect(ordenar(itens).map((i) => i.id)).toEqual(['～', '😀'])
  })
  it('folha prefixa 0x00', () => {
    const item = { tipo: 'a', id: 'b' }
    // sha256 do texto com o byte 0x00 na frente.
    expect(paraHex(folha(item))).toBe(sha256(`\u0000${jcs(item)}`))
  })
})

describe('provas de inclusão (caso relatorio dos vetores)', () => {
  const caso = vetores.relatorio
  it('cada folha sobe até a raiz; folha alterada não', () => {
    for (const item of caso.itens as Item[]) {
      const passos = (caso.provas as Record<string, Passo[]>)[`${item.tipo}:${item.id}`]
      expect(paraHex(raizPelaProva(item, passos))).toBe(caso.raiz)
      expect(paraHex(raizPelaProva({ ...item, id: `${item.id}x` }, passos))).not.toBe(caso.raiz)
    }
  })
})
