import { describe, expect, it } from 'vitest'
import { REGIAO, ZOOM_MAXIMO, restringir } from './limites'

// A área visível de uma tela de 1440 × 900 com o painel aberto (margem da câmera: 500, 90, 90, 90).
const AREA = { largura: 850, altura: 720 }

describe('limites do mapa (demo do hackathon: só o RS)', () => {
  it('não afasta além do RS inteiro, e afastado ele fica no meio da área visível', () => {
    const r = restringir(10, 40, 0, AREA)
    expect(r.zoom).toBeGreaterThan(5)
    expect(r.zoom).toBeLessThan(6.5)
    expect(r.lng).toBeCloseTo((REGIAO[0] + REGIAO[2]) / 2, 0)
    // Com o zoom mínimo, arrastar não move nada.
    expect(restringir(-50, -30, r.zoom, AREA)).toEqual(r)
  })

  it('aproximado, dentro do RS a câmera vai aonde for pedida', () => {
    expect(restringir(-53.8, -29.69, 12, AREA)).toEqual({ lng: expect.closeTo(-53.8, 9), lat: expect.closeTo(-29.69, 9), zoom: 12 })
    expect(restringir(-53.8, -29.69, 20, AREA).zoom).toBe(ZOOM_MAXIMO)
  })

  it('aproximado, não para longe do contorno, mesmo dentro da caixa do RS', () => {
    // Tacuarembó (Uruguai) e Curitibanos (SC) ficam dentro da caixa; a câmera é puxada para a divisa (a 35% do menor
    // lado da área visível).
    for (const [lng, lat] of [[-55.98, -31.73], [-50.58, -27.28]]) {
      const r = restringir(lng, lat, 9, AREA)
      const distanciaPx = Math.hypot((r.lng - lng) / 360, Math.log(Math.tan(Math.PI / 4 + (r.lat * Math.PI) / 360)) / (2 * Math.PI) - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI)) * 512 * 2 ** 9
      expect(distanciaPx).toBeGreaterThan(100)
      expect(restringir(r.lng, r.lat, 9, AREA).lng).toBeCloseTo(r.lng, 9)
    }
    // Perto da divisa, do lado de fora, dentro da folga: fica.
    const pertoDoChui = restringir(-53.5, -33.85, 9, AREA)
    expect(pertoDoChui.lng).toBeCloseTo(-53.5, 6)
    // Bem aproximado na praia de Tramandaí, perto do contorno simplificado das UFs: não é puxado para dentro.
    const tramandai = restringir(-50.13, -29.98, 17, AREA)
    expect(tramandai.lng).toBeCloseTo(-50.13, 6)
    expect(tramandai.lat).toBeCloseTo(-29.98, 6)
  })
})
