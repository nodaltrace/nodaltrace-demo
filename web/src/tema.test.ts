import { describe, expect, it } from 'vitest'
import { PROXIMO, TEMA_PADRAO, lerTema } from './tema'

describe('tema', () => {
  it('o escuro é o padrão, também no lugar dos antigos "sistema" e "nodaltrace" e de qualquer valor desconhecido', () => {
    expect(TEMA_PADRAO).toBe('escuro')
    for (const salvo of [null, undefined, 'sistema', 'nodaltrace', 'azul']) expect(lerTema(salvo)).toBe('escuro')
    for (const t of ['claro', 'escuro'] as const) expect(lerTema(t)).toBe(t)
  })

  it('o botão do trilho troca um tema pelo outro', () => {
    expect(PROXIMO.escuro).toBe('claro')
    expect(PROXIMO.claro).toBe('escuro')
  })
})
