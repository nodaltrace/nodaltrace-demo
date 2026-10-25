import { describe, expect, it } from 'vitest'
import { fmtBiomas, fmtDataAno, fmtDatasBase, fmtDiaBrasilia, fmtHa } from './formato'

describe('formato', () => {
  it('hectares com uma casa decimal', () => {
    expect(fmtHa(1234.56)).toBe('1,234.6 ha')
  })

  it('biomas do maior para o menor, com a fração quando há mais de um', () => {
    expect(fmtBiomas([])).toBe('Outside the IBGE biomes')
    expect(fmtBiomas([{ nome: 'Pampa', fracao: 1 }])).toBe('Pampa')
    expect(fmtBiomas([{ nome: 'Atlantic Forest', fracao: 0.624 }, { nome: 'Pampa', fracao: 0.376 }])).toBe('Atlantic Forest 62% · Pampa 38%')
  })

  it('data em UTC, no formato dos EUA', () => {
    expect(fmtDataAno('2026-10-08')).toBe('Oct 8, 2026')
  })

  it('instante no dia de Brasília: a carga às 22h de Brasília não vira o dia seguinte', () => {
    expect(fmtDiaBrasilia('2026-10-09T01:18:39Z')).toBe('Oct 8, 2026')
  })

  it('datas de uma base: dados, publicação só se informada, carga', () => {
    const base = { dados_ate: '2026-10-01', publicado_em: null, carregado_em: '2026-10-09T01:18:39Z' }
    expect(fmtDatasBase(base, 'updates')).toBe('updates through Oct 1, 2026 · loaded Oct 8, 2026')
    expect(fmtDatasBase({ ...base, publicado_em: '2026-10-05' })).toBe('data through Oct 1, 2026 · published Oct 5, 2026 · loaded Oct 8, 2026')
    expect(fmtDatasBase({ ...base, dados_ate: null })).toBe('no data date · loaded Oct 8, 2026')
  })
})
