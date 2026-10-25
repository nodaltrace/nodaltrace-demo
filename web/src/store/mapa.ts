import { create } from 'zustand'
import { mapaBaseSalvo, salvarMapaBase, type MapaBase } from '../map/satelite'
import { fonteHistoricaSalva, salvarFonteHistorica, type FonteHistorica } from '../map/historico'

/** O que o mapa mostra: camadas, mapa-base, ajustes, onde a câmera está e a comparação de imagens aberta sobre ele. */

export interface Camadas {
  /** Rótulos do próprio mapa-base: nomes de cidades e localidades. */
  rotulosMapa: boolean
  /** Imóveis do CAR. */
  car: boolean
  /** Alertas de desmatamento do MapBiomas e a parte deles dentro de cada imóvel. */
  alertas: boolean
  /** Biomas do IBGE (1:250.000). */
  biomas: boolean
}

/**
 * Ajustes de exibição do mapa: a partir de que zoom cada camada aparece e opacidades.
 * Os limites de cada faixa seguem o que o servidor de tiles entrega (na demo do hackathon, o CAR existe em tile a partir
 * do zoom 8: deploy/demo/032_demo_car_desde_zoom_8.sql).
 */
export interface Ajustes {
  carDesde: number
  /** Zoom a partir do qual os polígonos dos alertas aparecem. */
  alertaPoligonosDesde: number
  opacidadeCar: number
  opacidadeAlertas: number
  opacidadeBiomas: number
}

export const AJUSTES_PADRAO: Ajustes = {
  carDesde: 8,
  alertaPoligonosDesde: 5,
  opacidadeCar: 1,
  opacidadeAlertas: 1,
  opacidadeBiomas: 0.3,
}

const CHAVE_AJUSTES = 'nodaltrace:ajustes-mapa'

/** Ajustes guardados neste navegador (só conveniência de quem vê: sem eles, valem os padrões). */
function ajustesSalvos(): Ajustes {
  try {
    const salvo = JSON.parse(localStorage.getItem(CHAVE_AJUSTES) ?? '{}')
    return { ...AJUSTES_PADRAO, ...Object.fromEntries(Object.entries(salvo).filter(([k, v]) => k in AJUSTES_PADRAO && typeof v === 'number')) }
  } catch {
    return AJUSTES_PADRAO
  }
}

function salvarAjustes(a: Ajustes) {
  try {
    localStorage.setItem(CHAVE_AJUSTES, JSON.stringify(a))
  } catch {
    // sem armazenamento (aba privada, bloqueio): os ajustes valem só até recarregar
  }
}

/** Onde a câmera está: alimenta a escala e a altitude mostradas no canto inferior direito do mapa. */
export interface Vista {
  zoom: number
  lat: number
  /** Altura do mapa em pixels (a distância da câmera ao centro é proporcional a ela). */
  alturaPx: number
}

/**
 * Duas imagens de um imóvel escolhidas para comparar, e se a comparação está aberta no mapa. `antes` e `depois` são
 * ids das opções da listagem (no MapBiomas, o alerta, igual nos dois); nulos, valem as datas sugeridas, em volta de
 * `deteccao` quando houver (atalho de um alerta do MapBiomas sem imagem).
 */
export interface Comparacao {
  cod: string
  fonte: FonteHistorica
  antes: string | null
  depois: string | null
  deteccao: string | null
  aberta: boolean
}

interface EstadoMapa {
  camadas: Camadas
  /** Imagem de satélite ou o mapa neutro nas cores do tema (guardado no navegador). */
  mapaBase: MapaBase
  /** Fonte das imagens históricas dos imóveis do CAR (guardada no navegador). */
  fonteHistorica: FonteHistorica
  comparacao: Comparacao | null
  ajustes: Ajustes
  vista: Vista

  alternarCamada: (c: keyof Camadas) => void
  /** Liga as camadas pedidas, sem desligar nenhuma. */
  ligarCamadas: (c: (keyof Camadas)[]) => void
  setMapaBase: (b: MapaBase) => void
  /** Troca a fonte das imagens históricas; a comparação continua (aberta ou não), nas datas sugeridas da nova fonte. */
  setFonteHistorica: (f: FonteHistorica) => void
  setComparacao: (c: Comparacao | null) => void
  setAjuste: <K extends keyof Ajustes>(k: K, v: Ajustes[K]) => void
  restaurarAjustes: () => void
  setVista: (v: Vista) => void
}

export const useMapa = create<EstadoMapa>((set) => ({
  // Demo do hackathon: os imóveis do CAR e os alertas já ligados, para o jurado ver os dados sem procurar o controle.
  camadas: { rotulosMapa: true, car: true, alertas: true, biomas: false },
  mapaBase: mapaBaseSalvo(),
  fonteHistorica: fonteHistoricaSalva(),
  comparacao: null,
  ajustes: ajustesSalvos(),
  vista: { zoom: 4, lat: -14, alturaPx: 800 },

  alternarCamada: (c) => set((s) => ({ camadas: { ...s.camadas, [c]: !s.camadas[c] } })),
  ligarCamadas: (c) => set((s) => ({ camadas: { ...s.camadas, ...Object.fromEntries(c.map((k) => [k, true])) } })),
  setMapaBase: (mapaBase) => {
    salvarMapaBase(mapaBase)
    set({ mapaBase })
  },
  setFonteHistorica: (fonteHistorica) => {
    salvarFonteHistorica(fonteHistorica)
    set((s) => ({
      fonteHistorica,
      comparacao: s.comparacao && { ...s.comparacao, fonte: fonteHistorica, antes: null, depois: null },
    }))
  },
  setComparacao: (comparacao) => set({ comparacao }),
  setAjuste: (k, v) =>
    set((s) => {
      const ajustes = { ...s.ajustes, [k]: v }
      salvarAjustes(ajustes)
      return { ajustes }
    }),
  restaurarAjustes: () => {
    salvarAjustes(AJUSTES_PADRAO)
    set({ ajustes: AJUSTES_PADRAO })
  },
  setVista: (vista) => set({ vista }),
}))
