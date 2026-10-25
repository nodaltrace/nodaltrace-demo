// Gera os GeoJSON de base do mapa: as UFs (public/geo/uf.json, se public/geo/uf.raw.json tiver sido baixado) e, a partir
// delas, o contorno do Brasil e a máscara do que fica fora dele (src/map/brasil.json, que vai junto no código do mapa).
// Uso: node scripts/geo.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import polygonClipping from 'polygon-clipping'

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d

// Douglas-Peucker simples sobre um anel [lng, lat][]
function simplify(ring, tol) {
  if (ring.length < 5) return ring
  const keep = new Uint8Array(ring.length)
  keep[0] = keep[ring.length - 1] = 1
  const stack = [[0, ring.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [ax, ay] = ring[a]
    const [bx, by] = ring[b]
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy)
    let max = 0
    let idx = -1
    for (let i = a + 1; i < b; i++) {
      // anel fechado: extremos coincidem, usa distância ao ponto
      const d =
        len < 1e-9
          ? Math.hypot(ring[i][0] - ax, ring[i][1] - ay)
          : Math.abs(dy * ring[i][0] - dx * ring[i][1] + bx * ay - by * ax) / len
      if (d > max) {
        max = d
        idx = i
      }
    }
    if (max > tol && idx > 0) {
      keep[idx] = 1
      stack.push([a, idx], [idx, b])
    }
  }
  return ring.filter((_, i) => keep[i])
}

function simplifyGeometry(g, tol, digits) {
  // Ilha pequena que a simplificação apagaria fica com o desenho original.
  const ring = (r) => {
    const s = simplify(r, tol)
    return (s.length >= 4 ? s : r).map(([x, y]) => [round(x, digits), round(y, digits)])
  }
  const poly = (p) => p.map(ring).filter((r) => r.length >= 4)
  if (g.type === 'Polygon') return { type: 'Polygon', coordinates: poly(g.coordinates) }
  if (g.type === 'MultiPolygon')
    return { type: 'MultiPolygon', coordinates: g.coordinates.map(poly).filter((p) => p.length) }
  return g
}

if (existsSync('public/geo/uf.raw.json')) {
  const uf = JSON.parse(readFileSync('public/geo/uf.raw.json', 'utf8'))
  uf.features = uf.features.map((f) => ({
    type: 'Feature',
    properties: { nome: f.properties.name, sigla: f.properties.sigla },
    geometry: simplifyGeometry(f.geometry, 0.02, 3),
  }))
  writeFileSync('public/geo/uf.json', JSON.stringify(uf))
}

/** Área com sinal (positiva no sentido anti-horário): os buracos de um polígono correm ao contrário do anel externo. */
const area = (anel) => anel.reduce((s, [x, y], i) => (i ? s + (anel[i - 1][0] - x) * (anel[i - 1][1] + y) : s), 0) / 2
const sentido = (anel, antiHorario) => ((area(anel) > 0) === antiHorario ? anel : [...anel].reverse())

// O Brasil é a união das UFs do mesmo uf.json das linhas de UF: a borda do país e as linhas batem em qualquer zoom.
// Cada UF foi simplificada por si, então as divisas vizinhas não coincidem e deixam frestas, que na união viram buracos
// minúsculos; só os anéis externos ficam (o Brasil não tem enclaves). A fresta que chega à borda do país não vira buraco,
// e sim uma ponta fina para dentro do anel externo (a do Acre com o Amazonas tem 250 km): `semPontas` a fecha.
const uf = JSON.parse(readFileSync('public/geo/uf.json', 'utf8'))
const uniao = polygonClipping.union(...uf.features.map((f) => f.geometry.coordinates))
const aneis = uniao.map(([externo]) => semPontas(externo.map(([x, y]) => [round(x, 3), round(y, 3)])))

/**
 * Tira do anel fechado as pontas finas para dentro (ângulo menor que `graus`, com o vão do lado de fora), até não sobrar
 * nenhuma. As pontas para fora ficam: são terra de verdade, como a Restinga da Marambaia.
 */
function semPontas(anel, graus = 5) {
  let v = sentido(anel, true).slice(0, -1)
  const fresta = (a, b, c) => {
    const [ux, uy, wx, wy] = [a[0] - b[0], a[1] - b[1], c[0] - b[0], c[1] - b[1]]
    const n = Math.hypot(ux, uy) * Math.hypot(wx, wy)
    if (!n) return true
    // No sentido anti-horário, o vão fica fora quando a borda vira à direita em b.
    const direita = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0
    return direita && (Math.acos(Math.max(-1, Math.min(1, (ux * wx + uy * wy) / n))) * 180) / Math.PI < graus
  }
  for (let mudou = true; mudou && v.length > 3; ) {
    mudou = false
    for (let i = 0; i < v.length && v.length > 3; i++) {
      if (fresta(v.at(i - 1), v[i], v[(i + 1) % v.length])) {
        v.splice(i, 1)
        mudou = true
        i--
      }
    }
  }
  return [...v, v[0]]
}

/** Envoltória convexa (cadeia monótona) de pontos [x, y]. */
function envoltoria(pontos) {
  const p = [...pontos].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const giro = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const metade = (lista) => {
    const h = []
    for (const q of lista) {
      while (h.length >= 2 && giro(h.at(-2), h.at(-1), q) <= 0) h.pop()
      h.push(q)
    }
    return h.slice(0, -1)
  }
  const anel = [...metade(p), ...metade([...p].reverse())]
  return [...anel, anel[0]]
}

// O Brasil com uma faixa em volta: cada lado do contorno engrossado, unidos ao país. Do zoom de detalhe em diante (ver
// map/estilo.ts), a máscara de fora começa na faixa e não na borda: a borda simplificada das UFs desvia até 0,02° da
// real e cortaria terra do Brasil na costa e nas divisas. Ali, o mar sai dos tiles (preciso) e, com token do Mapbox, os
// vizinhos saem dos polígonos dele.
function comFaixa(graus, tolerancia) {
  // Octógonos e não quadrados: a borda da faixa sai sem degraus.
  const octogono = ([x, y]) => Array.from({ length: 8 }, (_, k) => [x + graus * Math.cos((k + 0.5) * Math.PI / 4), y + graus * Math.sin((k + 0.5) * Math.PI / 4)])
  const lados = aneis.flatMap((a) => a.slice(1).map((b, i) => [[envoltoria([...octogono(a[i]), ...octogono(b)])]]))
  return polygonClipping
    .union(aneis.map((a) => [a]), ...lados)
    .map(([externo]) => simplify(externo, tolerancia).map(([x, y]) => [round(x, 3), round(y, 3)]))
}
// Perto (~3 km, sem token do Mapbox): cobre o desvio da simplificação. Longe (~11 km, com token): mais larga que a folga
// com que map/recorte.ts pede a foto e os polígonos do Mapbox, então não há foto fora dela.
const perto = comFaixa(0.03, 0.002)
const longe = comFaixa(0.1, 0.005)

const MUNDO = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]
const brasil = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { parte: 'brasil' }, geometry: { type: 'MultiPolygon', coordinates: aneis.map((a) => [sentido(a, true)]) } },
    // As máscaras, por cima do mapa-base, para nada de fora (vias, rios, nomes) aparecer: o mundo menos o Brasil, e o
    // mundo menos o Brasil com cada faixa.
    { type: 'Feature', properties: { parte: 'fora' }, geometry: { type: 'Polygon', coordinates: [MUNDO, ...aneis.map((a) => sentido(a, false))] } },
    { type: 'Feature', properties: { parte: 'perto' }, geometry: { type: 'Polygon', coordinates: [MUNDO, ...perto.map((a) => sentido(a, false))] } },
    { type: 'Feature', properties: { parte: 'longe' }, geometry: { type: 'Polygon', coordinates: [MUNDO, ...longe.map((a) => sentido(a, false))] } },
  ],
}
writeFileSync('src/map/brasil.json', JSON.stringify(brasil))
