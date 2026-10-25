import { describe, expect, it } from 'vitest'
import { barra, semCamadas } from './escalaVista'

describe('limite de visibilidade das camadas', () => {
  it.each([0, -30, 60])('oculta no patamar de 500 km e acima, na latitude %s', (lat) => {
    const limiteZoom = Math.log2(40075016.686 * Math.cos(lat * Math.PI / 180) * 110 / (512 * 500_000))
    // Logo antes e depois da mudança da barra de 500 km para 200 km.
    expect(barra(limiteZoom - 0.000001, lat).metros).toBe(500_000)
    expect(semCamadas(limiteZoom - 0.000001, lat)).toBe(true)
    expect(semCamadas(limiteZoom - 2, lat)).toBe(true)
    expect(barra(limiteZoom + 0.000001, lat).metros).toBe(200_000)
    expect(semCamadas(limiteZoom + 0.000001, lat)).toBe(false)
  })

  it('reavalia ao mover a latitude, mesmo sem mudar o zoom', () => {
    expect(semCamadas(4, 0)).toBe(true)
    expect(semCamadas(4, 60)).toBe(false)
  })
})
