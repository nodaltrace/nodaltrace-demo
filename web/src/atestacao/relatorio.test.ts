import { describe, expect, it } from 'vitest'
import { getAttestationDataCodec, type Schema } from '@solana/attestation'
import vetores from '../../../docs/atestacao/vetores.json'
import { deHex, jcs, type Item } from './merkle'
import { LAYOUT, avisoDeAtraso, camposEsperados, conferirCampos, fmtDuracao, lerArquivo, nonceDoRelatorio, normalizarCampos, urlExplorer } from './relatorio'

// O caso `relatorio` dos vetores do contrato, o mesmo que a API, o attestor e docs/atestacao/verificar.py conferem.
const caso = vetores.relatorio
const prova = (cods: string[]) =>
  JSON.stringify({
    formato: 'NT_RELATORIO_PROVA/1',
    relatorio: 'NT-2026-000002',
    raiz: caso.raiz,
    itens: (caso.itens as Item[]).filter((i) => i.tipo === 'cabecalho' || cods.includes(i.id)),
    provas: Object.fromEntries(
      (caso.itens as Item[]).filter((i) => i.tipo === 'cabecalho' || cods.includes(i.id)).map((i) => [`${i.tipo}:${i.id}`, (caso.provas as Record<string, unknown>)[`${i.tipo}:${i.id}`]]),
    ),
  })

describe('documento inteiro', () => {
  it('recalcula a raiz e os campos da rede dos vetores', () => {
    const a = lerArquivo(caso.documento)
    expect(a.tipo).toBe('documento')
    expect(a.problemas).toEqual([])
    expect(a.raiz).toBe(caso.raiz)
    expect(camposEsperados(a)).toEqual(caso.campos)
    expect(nonceDoRelatorio(a.cabecalho.serie, a.cabecalho.numero)).toBe(caso.nonce)
  })

  it('qualquer mudança no conteúdo muda a raiz', () => {
    const doc = JSON.parse(caso.documento)
    doc.itens[2].resultados[0].status = 'conforme'
    const a = lerArquivo(jcs(doc))
    expect(a.raiz).not.toBe(caso.raiz)
    expect(conferirCampos(camposEsperados(a), caso.campos).find((c) => c.campo === 'root')!.ok).toBe(false)
  })

  it('aponta o texto fora da forma canônica, mas a raiz vale pelo conteúdo', () => {
    const a = lerArquivo(JSON.stringify(JSON.parse(caso.documento), null, 2))
    expect(a.raiz).toBe(caso.raiz)
    expect(a.problemas.join()).toMatch(/canonical/)
  })

  it('recusa o que não é um relatório', () => {
    expect(() => lerArquivo('não é json')).toThrow(/JSON/)
    expect(() => lerArquivo('{"itens": []}')).toThrow(/leaves/)
    expect(() => lerArquivo(JSON.stringify({ itens: [{ tipo: 'imovel', id: 'x' }] }))).toThrow(/header/)
    const doc = JSON.parse(caso.documento)
    doc.itens[0].formato = 'NT_LOTE'
    expect(() => lerArquivo(JSON.stringify(doc))).toThrow(/format/)
  })
})

describe('prova parcial', () => {
  const alvo = (caso.itens as Item[])[3].id

  it('confere com a raiz sem os outros imóveis', () => {
    const a = lerArquivo(prova([alvo]))
    expect(a.tipo).toBe('prova')
    expect(a.problemas).toEqual([])
    expect(a.raiz).toBe(caso.raiz)
    expect(a.itens.map((i) => i.id)).toEqual(['cabecalho', alvo])
    expect(camposEsperados(a)).toEqual(caso.campos)
  })

  it('folha alterada leva a outra raiz', () => {
    const p = JSON.parse(prova([alvo]))
    p.itens[1].status = 'nao_conforme'
    const a = lerArquivo(JSON.stringify(p))
    expect(a.problemas.join()).toMatch(/different roots|root written/)
  })
})

describe('campos lidos da rede', () => {
  it('decodifica os bytes do SAS dos vetores e confere com o esperado', () => {
    const schema = { layout: LAYOUT.map(([, t]) => t), fieldNames: LAYOUT.map(([n]) => n) } as unknown as Schema
    const [cru] = getAttestationDataCodec(schema).read(deHex(caso.dados_sas), 0)
    const lido = normalizarCampos(cru as Record<string, unknown>)
    expect(lido).toEqual(caso.campos)
    expect(conferirCampos(caso.campos, lido).every((c) => c.ok)).toBe(true)
    expect(conferirCampos(caso.campos, null).every((c) => !c.ok)).toBe(true)
  })

  it('link do explorer com o cluster, menos na mainnet', () => {
    expect(urlExplorer('tx', 'abc', 'devnet')).toBe('https://explorer.solana.com/tx/abc?cluster=devnet')
    expect(urlExplorer('address', 'abc', 'mainnet')).toBe('https://explorer.solana.com/address/abc')
  })
})

describe('emissão e bloco', () => {
  const emissao = 1_792_677_787
  const bloco = (s: number) => new Date((emissao + s) * 1000).toISOString()

  it('não avisa com o bloco perto da emissão ou sem a hora do bloco', () => {
    expect(avisoDeAtraso(emissao, bloco(3))).toBeNull()
    expect(avisoDeAtraso(emissao, bloco(600))).toBeNull()
    expect(avisoDeAtraso(emissao, bloco(-600))).toBeNull()
    expect(avisoDeAtraso(emissao, null)).toBeNull()
  })

  it('avisa do registro tardio e do relógio adiantado', () => {
    expect(avisoDeAtraso(emissao, bloco(2 * 3600 + 5 * 60))).toMatch(/^The registration came 2 h 5 min after the declared issue time/)
    expect(avisoDeAtraso(emissao, bloco(-3 * 86400))).toMatch(/^The declared issue time is 3 days after the block/)
  })

  it('durações', () => {
    expect([601, 3600, 5400, 86400, 200000].map(fmtDuracao)).toEqual(['10 min', '1 h', '1 h 30 min', '1 day', '2 days'])
  })
})
