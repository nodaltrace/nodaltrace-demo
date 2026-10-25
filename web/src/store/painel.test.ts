import { describe, expect, it } from 'vitest'
import { LARGURA_MAXIMA, LARGURA_MINIMA, limitarLargura } from './painel'

describe('largura do painel', () => {
  it('fica entre a mínima e a máxima', () => {
    expect(limitarLargura(100, 1440)).toBe(LARGURA_MINIMA)
    expect(limitarLargura(5000, 1920)).toBe(LARGURA_MAXIMA)
    expect(limitarLargura(380.6, 1440)).toBe(381)
  })

  it('em tela menor, deixa sempre um pedaço do mapa ao lado', () => {
    // 900 px de tela: o trilho (56) e 360 px de mapa sobram.
    expect(limitarLargura(600, 900)).toBe(484)
  })
})
