/**
 * As cores do mapa. O Brasil é o mesmo nos dois temas da interface: um cinza-escuro com um fundo de verde, onde as cores
 * de status, os alertas e os biomas aparecem bem. Só o que fica fora dele acompanha o tema. O CSS não alcança o
 * MapLibre, por isso elas ficam aqui.
 */
import type { Tema } from '../tema'

export interface CoresMapa {
  /** Tudo o que fica fora do Brasil (o mar e os vizinhos): as máscaras. */
  fora: string
  /** A terra do Brasil: o fundo do mapa. */
  brasil: string
  agua: string
  /** O contorno do Brasil e a fronteira. */
  fronteira: string
  vias: string
  uf: string
  textoMapa: string
  /** Halo dos nomes de lugares, que ficam sobre o Brasil. */
  halo: string
  /** Contorno do imóvel aberto. */
  contorno: string
  /** Traço das bordas dos biomas. */
  bordaBioma: string
  /** Anel em volta dos pontos dos imóveis em análise: claro, para o ponto saltar por cima dos polígonos do CAR. */
  anel: string
  /**
   * Imóveis escolhidos para a análise, antes do resultado: um azul, longe dos verdes da marca e das cores de status
   * (verde, âmbar, vermelho e cinza), para não se confundir com elas.
   */
  destaque: string
}

export const MAPA: CoresMapa = {
  fora: '#0A0C0B',
  brasil: '#1D2320',
  agua: '#122026',
  fronteira: 'rgba(214,226,210,0.5)',
  vias: 'rgba(214,226,210,0.14)',
  uf: 'rgba(214,226,210,0.24)',
  textoMapa: 'rgba(231,237,229,0.66)',
  halo: '#0A0C0B',
  contorno: '#FFFFFF',
  bordaBioma: '#9AA598',
  anel: '#FFFFFF',
  destaque: '#5AA9E6',
}

/** No tema claro, fora do Brasil fica cinza-claro, perto do fundo da interface; o país continua escuro. */
const MAPA_CLARO: CoresMapa = { ...MAPA, fora: '#D8DCD5' }

export const coresMapa = (tema: Tema): CoresMapa => (tema === 'claro' ? MAPA_CLARO : MAPA)
