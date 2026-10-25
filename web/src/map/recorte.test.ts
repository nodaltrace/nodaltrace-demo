import { describe, expect, it } from 'vitest'
import uf from '../../public/geo/uf.json'
import { contornos, limitesDoTile, tileTocaBrasil } from './recorte'

const brasil = contornos(uf)

/** O tile z/x/y que contém o ponto (lon, lat). */
const tile = (z: number, lon: number, lat: number): [number, number, number] => {
  const n = 2 ** z
  const r = (lat * Math.PI) / 180
  return [z, Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)]
}

describe('tiles que tocam o Brasil', () => {
  it('limites do tile no esquema XYZ', () => {
    const [o, s, l, n] = limitesDoTile(1, 0, 0)
    expect([o, l]).toEqual([-180, 0])
    expect(s).toBeCloseTo(0)
    expect(n).toBeCloseTo(85.0511, 3)
  })

  it.each([
    ['interior (Brasília)', -47.88, -15.79, 12],
    ['divisa com o Paraguai (Foz do Iguaçu)', -54.59, -25.53, 12],
    ['costa (Copacabana)', -43.18, -22.97, 14],
    ['Fernando de Noronha', -32.42, -3.85, 12],
    ['Trindade', -29.32, -20.51, 12],
    ['São Pedro e São Paulo', -29.35, 0.92, 12],
    ['Abrolhos', -38.70, -17.96, 14],
    ['Alcatrazes', -45.69, -24.10, 14],
    ['Queimada Grande', -46.67, -24.49, 14],
    ['Arvoredo', -48.37, -27.27, 16],
    ['Ilha da Vitória', -45.016, -23.738, 16],
    ['Cananéia', -47.851, -25.115, 16],
    ['ilhas da foz do Amazonas', -49.573, 0.387, 16],
    ['canais da foz do Amazonas', -49.95, 0.43, 16],
    ['Queimada Pequena', -46.807, -24.375, 16],
    ['meio da Lagoa dos Patos', -51.2, -31.0, 14],
    ['meio da Lagoa Mirim', -53.1, -32.9, 14],
  ])('pede o tile: %s', (_, lon, lat, z) => {
    expect(tileTocaBrasil(brasil, ...tile(z, lon, lat))).toBe(true)
  })

  it.each([
    ['Assunção', -57.58, -25.28, 10],
    ['Santa Cruz de la Sierra', -63.18, -17.78, 10],
    ['Montevidéu', -56.16, -34.9, 10],
    ['Atlântico entre a costa e Trindade', -35, -20, 10],
    ['Lima, fora da caixa', -77.03, -12.05, 8],
  ])('não pede o tile: %s', (_, lon, lat, z) => {
    expect(tileTocaBrasil(brasil, ...tile(z, lon, lat))).toBe(false)
  })

  it('tiles grandes que contêm o Brasil inteiro', () => {
    expect(tileTocaBrasil(brasil, 0, 0, 0)).toBe(true)
    expect(tileTocaBrasil(brasil, 3, 2, 4)).toBe(true)
  })

  it('tile dentro de um anel, sem vértice dentro: pelo centro', () => {
    const quadrado = contornos({ features: [{ geometry: { type: 'Polygon', coordinates: [[[-80, -50], [-30, -50], [-30, 0], [-80, 0], [-80, -50]]] } }] })
    expect(tileTocaBrasil(quadrado, 10, 360, 580, 0)).toBe(true)
  })

  it('tile cortado por uma aresta, sem vértice dentro e com o centro fora: pelas arestas', () => {
    // Faixa fina que atravessa o tile 4/5/9 (-67,5…-45; -41…-21,9) de lado a lado, longe do centro dele (-31,9).
    const faixa = contornos({ features: [{ geometry: { type: 'Polygon', coordinates: [[[-80, -25], [-30, -25], [-30, -25.1], [-80, -25.1], [-80, -25]]] } }] })
    expect(limitesDoTile(4, 5, 9)[1]).toBeLessThan(-40)
    expect(tileTocaBrasil(faixa, 4, 5, 9, 0)).toBe(true)
    expect(tileTocaBrasil(faixa, 4, 5, 8, 0)).toBe(false)
  })

  it('a folga pega a margem do outro lado da divisa', () => {
    // Ciudad del Este, uns 7 km a oeste do Paraná: com a folga, o tile do zoom 14 do lado paraguaio ainda vem.
    expect(tileTocaBrasil(brasil, ...tile(14, -54.67, -25.51))).toBe(true)
    expect(tileTocaBrasil(brasil, ...tile(14, -54.67, -25.51), 0)).toBe(false)
  })
})
