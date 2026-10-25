import { describe, expect, it } from 'vitest'

// Lista sem importar: o glob é preguiçoso.
const arquivos = Object.keys(import.meta.glob('./**/*.{ts,tsx}'))

describe('nomes dos arquivos', () => {
  it('não há dois módulos que só diferem em maiúsculas', () => {
    // No macOS e no Windows o disco ignora a caixa: `./DagOrigens` abriria `dagOrigens.ts` e quebraria o app.
    const porChave = new Map<string, string[]>()
    for (const a of arquivos) {
      const chave = a.replace(/\.tsx?$/, '').toLowerCase()
      porChave.set(chave, [...(porChave.get(chave) ?? []), a])
    }
    expect([...porChave.values()].filter((v) => v.length > 1)).toEqual([])
  })
})
