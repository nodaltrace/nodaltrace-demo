import type { MapGeoJSONFeature } from 'maplibre-gl'
import { buscarFichaDaFeicao } from '../api/hooks'

/**
 * O código do imóvel de uma feição do mapa. As partes dos alertas dentro dos imóveis (car_alerta) trazem o código; os
 * imóveis do CAR, só o id da feição (o código era quase metade do tile), que a API resolve. Null se não houver imóvel.
 */
export async function codDaFeicao(f: MapGeoJSONFeature | undefined): Promise<string | null> {
  const cod = f?.properties?.cod
  if (cod) return String(cod)
  if (typeof f?.id !== 'number') return null
  try {
    return (await buscarFichaDaFeicao(f.id)).cod_imovel
  } catch {
    // Feição de antes da última carga (o id mudou) ou API fora do ar: o clique não abre nada.
    return null
  }
}
