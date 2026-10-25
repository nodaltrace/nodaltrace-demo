import { describe, expect, it } from 'vitest'
import { caminhoDe, lerRota, montandoSelecao, naAnalise, type Rota } from './caminhos'

describe('rotas do painel na URL', () => {
  const rotas: [string, Rota][] = [
    ['/', { tela: 'inicio' }],
    ['/imovel/RS-4300471-24B4E305B8DC435BBEE925806EA67951', { tela: 'imovel', cod: 'RS-4300471-24B4E305B8DC435BBEE925806EA67951' }],
    ['/selecao', { tela: 'selecao' }],
    ['/selecao/analises', { tela: 'analises' }],
    ['/relatorio/NT-2026-000010', { tela: 'relatorio', id: 'NT-2026-000010' }],
  ]

  it('ida e volta entre caminho e rota', () => {
    for (const [caminho, rota] of rotas) {
      expect(lerRota(caminho)).toEqual(rota)
      expect(caminhoDe(rota)).toBe(caminho)
    }
  })

  it('código em minúsculas e barra no fim', () => {
    expect(lerRota('/imovel/rs-4300471-24b4e305/')).toEqual({ tela: 'imovel', cod: 'RS-4300471-24B4E305' })
    expect(lerRota('/relatorio/nt-2026-000001')).toEqual({ tela: 'relatorio', id: 'NT-2026-000001' })
  })

  it('caminho desconhecido é o início', () => {
    for (const c of ['/qualquer', '/imovel', '/imovel/X/mais', '/selecao/outra', '/relatorio/', '/%E0%A4%A']) expect(lerRota(c)).toEqual({ tela: 'inicio' })
  })
})

describe('seção do trilho', () => {
  it('a análise vale para as duas etapas da seleção e para o relatório; o início, para o resto', () => {
    expect([{ tela: 'selecao' }, { tela: 'analises' }, { tela: 'relatorio', id: 'NT-2026-000001' }].every((r) => naAnalise(r as Rota))).toBe(true)
    expect([{ tela: 'inicio' }, { tela: 'imovel', cod: 'RS-4314175-7209ACC7' }].some((r) => naAnalise(r as Rota))).toBe(false)
    // O clique no mapa monta a seleção só antes do relatório.
    expect(montandoSelecao({ tela: 'relatorio', id: 'NT-2026-000001' })).toBe(false)
    expect(montandoSelecao({ tela: 'analises' })).toBe(true)
  })
})
