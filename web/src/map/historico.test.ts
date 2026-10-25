import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImagensImovel, OpcaoImagemInpe, OpcaoImagemMapbiomas } from '../api/tipos'
import { comparavel, fmtDia, notaResolucao, resolverEscolha } from './historico'

/** O módulo não lê nada ao ser importado, mas o armazenamento é por caso: cada um importa de novo. */
async function carregar(salvo: string | null, falha = false) {
  const guardado = new Map(salvo ? [['nodaltrace:fonte-historica', salvo]] : [])
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => { if (falha) throw new Error('SecurityError'); return guardado.get(k) ?? null },
    setItem: (k: string, v: string) => { if (falha) throw new Error('SecurityError'); guardado.set(k, v) },
  })
  vi.resetModules()
  return { ...(await import('./historico')), guardado }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('fonte guardada', () => {
  it('começa no MapBiomas', async () => {
    expect((await carregar(null)).fonteHistoricaSalva()).toBe('mapbiomas')
  })

  it('lê e grava a escolha deste navegador', async () => {
    const m = await carregar('mapbiomas')
    expect(m.fonteHistoricaSalva()).toBe('mapbiomas')
    m.salvarFonteHistorica('mapbiomas')
    expect(m.guardado.get('nodaltrace:fonte-historica')).toBe('mapbiomas')
  })

  it('ignora fonte do INPE (desligada na demo), valor desconhecido e armazenamento bloqueado', async () => {
    expect((await carregar('sentinel2')).fonteHistoricaSalva()).toBe('mapbiomas')
    expect((await carregar('landsat')).fonteHistoricaSalva()).toBe('mapbiomas')
    const m = await carregar('cbers4a', true)
    expect(m.fonteHistoricaSalva()).toBe('mapbiomas')
    expect(() => m.salvarFonteHistorica('cbers4a')).not.toThrow()
  })
})

const trimestres = (...datas: string[]): OpcaoImagemInpe[] => datas.map((d) => ({ id: d, data: d, rotulo: d, cobertura: 1 }))
const S2 = trimestres('2022-07-01', '2022-10-01', '2023-01-01', '2023-04-01', '2023-07-01', '2023-10-01')

const foto = (data: string) => ({ data, url: `https://image.alerta.mapbiomas.org/${data}.png`, constelacao: 'PlanetScope' })
const alerta = (id: string, detectado_em: string, caso: 'mapa' | 'sem-mapa' | 'sem-imagem'): OpcaoImagemMapbiomas => ({
  id, alerta: id, detectado_em,
  limites: caso === 'mapa' ? [-48, -18, -47.9, -17.9] : null,
  antes: caso === 'sem-imagem' ? null : foto('2023-04-29'),
  depois: caso === 'sem-imagem' ? null : foto('2023-06-28'),
  caso,
  fontes_alternativas: ['sentinel2'],
})

/** Listagem como a API entrega, com a sugestão dela (as datas e o alerta sugeridos são calculados na API). */
const listagem = (fonte: 'sentinel2' | 'mapbiomas', opcoes: unknown[], sugestao: unknown) => ({
  fonte, opcoes, sugestao, resolucao_m: fonte === 'sentinel2' ? 10 : null, creditos: '', limites: [-48, -18, -47.9, -17.9], versao: 'v',
  contorno: { type: 'Point', coordinates: [0, 0] },
  alertas: { type: 'FeatureCollection', features: [] },
}) as ImagensImovel

describe('resolverEscolha', () => {
  it('INPE: sem escolha, o par sugerido pela API', () => {
    const e = resolverEscolha(listagem('sentinel2', S2, { antes: '2023-01-01', depois: '2023-07-01', cerca_deteccao: null }), null)
    expect(e?.tipo === 'inpe' && [e.antes.id, e.depois.id]).toEqual(['2023-01-01', '2023-07-01'])
  })

  it('INPE: a escolha do usuário vale; id que não está na listagem cai na sugestão', () => {
    const dados = listagem('sentinel2', S2, { antes: '2022-07-01', depois: '2023-10-01', cerca_deteccao: null })
    const e = resolverEscolha(dados, { antes: '2022-10-01', depois: '2099-01-01' })
    expect(e?.tipo === 'inpe' && [e.antes.id, e.depois.id]).toEqual(['2022-10-01', '2023-10-01'])
  })

  it('INPE sem imagem: nada para comparar', () => {
    expect(resolverEscolha(listagem('sentinel2', [], null), null)).toBeNull()
    expect(comparavel(null)).toBe(false)
  })

  it('MapBiomas: no mapa e sem mapa abrem; sem imagem fica desabilitado', () => {
    const opcoes = [alerta('1', '2021', 'mapa'), alerta('2', '2022', 'sem-mapa'), alerta('3', '2023', 'sem-imagem')]
    const caso = (id: string | null) => {
      const e = resolverEscolha(listagem('mapbiomas', opcoes, { alerta: '1' }), { antes: id, depois: id })
      return e?.tipo === 'mapbiomas' ? [e.alerta.id, e.caso, comparavel(e)] : null
    }
    expect(caso('1')).toEqual(['1', 'mapa', true])
    expect(caso('2')).toEqual(['2', 'sem-mapa', true])
    expect(caso('3')).toEqual(['3', 'sem-imagem', false])
    // Sem escolha (ou com um alerta que não é deste imóvel), o sugerido pela API.
    expect(caso(null)).toEqual(['1', 'mapa', true])
    expect(caso('99')).toEqual(['1', 'mapa', true])
    expect(resolverEscolha(listagem('mapbiomas', [], { alerta: null }), null)).toBeNull()
  })
})

describe('legenda', () => {
  it('data do dia no formato dos EUA, sem fuso', () => {
    expect(fmtDia('2023-04-29')).toBe('Apr 29, 2023')
    expect(fmtDia('2023-01-01T00:30:00-03:00')).toBe('Jan 1, 2023')
    expect(fmtDia('2021')).toBe('2021')
  })

  it('resolução só quando reduzida, com o motivo', () => {
    expect(notaResolucao(10, null)).toBeNull()
    expect(notaResolucao(20, 'defeito-inpe')).toBe('20 m (reduced resolution: defective INPE file in this area)')
    expect(notaResolucao(2.6, 'tamanho')).toBe('2.6 m (reduced resolution due to the property size)')
  })
})
