import { describe, expect, it } from 'vitest'
import { hashDe, lerHash } from './hashMapa'

describe('enquadramento no hash da URL', () => {
  it('lê o #zoom/lat/lon do MapLibre', () => {
    expect(lerHash('#14.5/-29.7543/-53.2121')).toEqual({ zoom: 14.5, latitude: -29.7543, longitude: -53.2121 })
    expect(lerHash('#2.3/8/-30')).toEqual({ zoom: 2.3, latitude: 8, longitude: -30 })
  })

  it('ignora hash vazio ou inválido', () => {
    for (const h of ['', '#', '#abc', '#10/-29', '#10/95/0', '#10/0/200']) expect(lerHash(h)).toBeNull()
  })

  it('casas decimais conforme o zoom, como o MapLibre', () => {
    expect(hashDe({ zoom: 14.567, latitude: -29.754321, longitude: -53.212345 })).toBe('#14.57/-29.75432/-53.21234')
    expect(hashDe({ zoom: 3, latitude: -15.123456, longitude: -47.987654 })).toBe('#3/-15.12/-47.99')
    expect(lerHash(hashDe({ zoom: 10, latitude: -30, longitude: -51 }))).toEqual({ zoom: 10, latitude: -30, longitude: -51 })
  })
})
