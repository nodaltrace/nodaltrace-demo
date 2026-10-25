import type { Status } from '../api/tipos'

export interface Exemplo {
  cod: string
  /** O resultado esperado na análise, para a forma ao lado do título. */
  status: Status
  titulo: string
  sub: string
  /**
   * [oeste, sul, leste, norte] a enquadrar sem esperar a ficha: o do imóvel (ref.car_resumo.limites) ou, no exemplo do
   * alerta vizinho, o do imóvel com o pedaço do alerta que encosta nele.
   */
  limites: [number, number, number, number]
}

/**
 * Demo do hackathon: imóveis reais do banco reduzido (deploy/demo/reduzir.sh), um por resultado, para o jurado começar
 * sem saber códigos do CAR. Os dados são os do banco; só a escolha é nossa.
 */
export const EXEMPLOS: Exemplo[] = [
  {
    cod: 'RS-4316907-09FEFD3BDA8446559785CD19EB35E1AF',
    status: 'conforme',
    titulo: 'Active CAR, no deforestation alerts',
    sub: 'Santa Maria · 187 ha',
    limites: [-53.64182, -29.87137, -53.61794, -29.8396],
  },
  {
    cod: 'RS-4306908-09BFCD8A1802416FB05DB6B9EF0513B7',
    status: 'nao_conforme',
    titulo: 'Deforestation after the EUDR cutoff',
    sub: 'Encruzilhada do Sul · 93 ha · 37.7 ha alert in Oct 2025',
    limites: [-52.95526, -30.67703, -52.94025, -30.6657],
  },
  {
    cod: 'RS-4306908-AA327998BF254C68A24594BA854AEC1E',
    status: 'nao_conforme',
    titulo: 'Passes the EUDR, fails RenovaBio',
    sub: 'Encruzilhada do Sul · 75 ha · alert in Oct 2020, between the two cutoffs',
    limites: [-52.82855, -30.58307, -52.8151, -30.57478],
  },
  {
    cod: 'RS-4306908-765EFE0BF9D74B86B42EF2D3FFFE0948',
    status: 'atencao',
    titulo: 'Small alert after the cutoff: needs review',
    sub: 'Encruzilhada do Sul · 228 ha · largest overlap under 1 ha',
    limites: [-52.91679, -30.6129, -52.89705, -30.58152],
  },
  {
    cod: 'RS-4314605-7122DB2C46634110BC404E7C919E9FC0',
    status: 'conforme',
    titulo: 'Alert next door, none on the property',
    sub: 'Piratini · 61 ha · 63 ha alert from Oct 2022 just outside its boundary',
    limites: [-53.13, -31.25018, -53.10893, -31.234],
  },
]
