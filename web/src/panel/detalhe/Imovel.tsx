import { useEffect } from 'react'
import { useImovel } from '../../api/hooks'
import type { Status } from '../../api/tipos'
import { Icone } from '../../components/icones'
import { Badge, Dado, Linha, Secao } from '../../components/ui'
import { fmtBiomas, fmtDataAno, fmtHa, fmtMesAno, fmtNum } from '../../formato'
import { camera } from '../../map/camera'
import { useEscolhaImagens } from '../../map/Comparacao'
import { comparavel, fmtDia, FONTES_HISTORICAS, NOME_FONTE } from '../../map/historico'
import { useMapa, type Comparacao } from '../../store/mapa'
import { enquadrarAoAbrir } from '../../store/rota'

/** Área em hectares inteiros, como no SICAR. */
const haInteiro = (ha: number | null) => (ha == null ? 'not reported' : `${fmtNum(Math.round(ha))} ha`)

const TITULO_EUDR: Record<Status, string> = {
  conforme: 'No alerts after the EUDR cutoff',
  atencao: 'Small alert after the cutoff: review',
  nao_conforme: 'Deforestation after the EUDR cutoff',
  pendente: 'Analysis pending',
}

/**
 * Duas datas (ou um alerta do MapBiomas) para comparar no mapa, na fonte escolhida em Controles › Mapa. A listagem só é
 * pedida com a seção aberta: o CBERS-4A leva alguns segundos na primeira vez.
 */
function CompararImagens({ cod }: { cod: string }) {
  const { fonte, consulta, dados, escolha, comparacao } = useEscolhaImagens(cod)
  const setComparacao = useMapa((s) => s.setComparacao)
  const aberta = !!comparacao?.aberta
  const detalhe = FONTES_HISTORICAS.find((f) => f.id === fonte)?.detalhe
  // Guarda a escolha resolvida (com as datas sugeridas no lugar), para ela não mudar sozinha depois.
  const atual: Comparacao = {
    cod, fonte, aberta, deteccao: comparacao?.deteccao ?? null,
    antes: escolha?.tipo === 'inpe' ? escolha.antes.id : escolha?.alerta.id ?? null,
    depois: escolha?.tipo === 'inpe' ? escolha.depois.id : escolha?.alerta.id ?? null,
  }

  let corpo
  if (consulta.isLoading) corpo = <p className="vazio">Fetching {NOME_FONTE[fonte]} images…</p>
  else if (consulta.error || !dados) corpo = <p className="nota">Couldn't list the images. {consulta.error?.message}</p>
  else if (dados.fonte !== 'mapbiomas') {
    // Atalho de um alerta do MapBiomas sem imagem: avisa se esta fonte não tem imagem dos dois lados da detecção.
    const deteccao = comparacao?.deteccao
    const semCercar = !!deteccao && dados.sugestao?.cerca_deteccao === false
    corpo = !escolha || escolha.tipo !== 'inpe' ? <p className="nota">No {NOME_FONTE[fonte]} image covers this property.</p> : (
      <>
        <div className="comparar-datas">
          {(['antes', 'depois'] as const).map((lado) => (
            <label key={lado} className="campo campo--meia">
              <span>{lado === 'antes' ? 'Before' : 'After'}</span>
              <select value={escolha[lado].id} onChange={(e) => setComparacao({ ...atual, [lado]: e.target.value })}>
                {dados.opcoes.map((o) => <option key={o.id} value={o.id}>{o.rotulo}</option>)}
              </select>
            </label>
          ))}
        </div>
        {semCercar && <p className="nota comparar-nota">No {NOME_FONTE[fonte]} images before and after the detection on {fmtDia(deteccao)}.</p>}
      </>
    )
  } else if (!escolha || escolha.tipo !== 'mapbiomas') {
    corpo = <p className="nota">No MapBiomas alerts on this property.</p>
  } else {
    const a = escolha.alerta
    corpo = (
      <>
        <label className="campo">
          <span>Alert</span>
          <select value={a.id} onChange={(e) => setComparacao({ ...atual, antes: e.target.value, depois: e.target.value, deteccao: null })}>
            {dados.opcoes.map((o) => (
              <option key={o.id} value={o.id}>
                #{o.alerta} · detected in {fmtMesAno(o.detectado_em)}{o.caso === 'sem-imagem' ? ' · no image' : ''}
              </option>
            ))}
          </select>
        </label>
        {/* Na demo, sem as fontes do INPE para onde o atalho levaria. */}
        {escolha.caso === 'sem-imagem' && <p className="nota comparar-nota">No MapBiomas image for this alert.</p>}
        {escolha.caso === 'sem-mapa' && <p className="nota comparar-nota">MapBiomas image without a map position: the comparison opens without panning or zooming.</p>}
      </>
    )
  }

  return (
    <>
      <p className="comparar-fonte">
        {NOME_FONTE[fonte]} · {detalhe}
        {FONTES_HISTORICAS.length > 1 && <span> · change the source in Controls › Map</span>}
      </p>
      {corpo}
      <div className="acoes">
        <button className="nt-btn nt-btn--outline nt-btn--sm" disabled={!aberta && !comparavel(escolha)} onClick={() => setComparacao({ ...atual, aberta: !aberta })}>
          {aberta ? 'Close comparison' : 'Open comparison'}
        </button>
      </div>
    </>
  )
}

export function DetalheImovel({ id }: { id: string }) {
  const { data: i, isLoading, error } = useImovel(id)
  // Aberto por um endereço sem enquadramento (um link compartilhado): o mapa vai até o imóvel.
  useEffect(() => {
    if (i && enquadrarAoAbrir()) camera.limites(i.limites)
  }, [i])

  if (isLoading) return <p className="vazio">Loading property…</p>
  if (error || !i) return <p className="vazio">Couldn't load CAR {id}. {error?.message}</p>

  return (
    <>
      <div className="titulo">
        <span className="etiqueta">CAR · {i.tipo_rotulo}</span>
        <h2 className="nt-data">{i.cod_imovel}</h2>
        <Badge status={i.conformidade_car.status} rotulo={`${i.situacao_rotulo} CAR`} />
      </div>
      {!i.vigente && <p className="nota">{i.conformidade_car.evidencia}.</p>}
      <div className="dados">
        <Dado rotulo="Municipality">{i.municipio} · {i.uf}</Dado>
        <Dado rotulo="Declared area">{haInteiro(i.area_ha)}</Dado>
        <Dado rotulo="Fiscal modules">{i.mod_fiscal == null ? 'not reported' : i.mod_fiscal.toLocaleString('en-US', { maximumFractionDigits: 1 })}{i.pequena_propriedade ? ' · small property' : ''}</Dado>
        <Dado rotulo="SICAR condition">{i.condicao}</Dado>
        {i.biomas && <Dado rotulo="Biome (IBGE)">{fmtBiomas(i.biomas)}</Dado>}
        {i.criado_sicar && <Dado rotulo="Registered on">{fmtDataAno(i.criado_sicar)}</Dado>}
        {i.atualizado_sicar && <Dado rotulo="Updated on">{fmtDataAno(i.atualizado_sicar)}</Dado>}
      </div>
      <div className="acoes">
        <button className="nt-btn nt-btn--outline nt-btn--sm" onClick={() => camera.mostrar(i.limites)}>Show property</button>
      </div>

      <Secao titulo="MapBiomas alerts" extra={<span className="nt-data">{i.alertas.length}</span>}>
        {!i.eudr ? (
          <p className="nota">MapBiomas Alerta not loaded in the database yet.</p>
        ) : (
          <>
            <Linha status={i.eudr.status} titulo={TITULO_EUDR[i.eudr.status]} sub={i.eudr.evidencia} />
            {i.alertas.map((a) => (
              <Linha
                key={a.alerta}
                status={a.status ?? undefined}
                icone={<Icone.alerta />}
                titulo={`Alert #${a.alerta}`}
                sub={[
                  `${fmtHa(a.area_ha)}${a.area_alerta_ha ? ` of a ${fmtHa(a.area_alerta_ha)} alert` : ''} inside the property`,
                  `detected in ${fmtMesAno(a.detectado_em)}`,
                  a.fontes.join(', '),
                  a.pos_corte ? null : "before the cutoff, doesn't count for the EUDR",
                ].filter(Boolean).join(' · ')}
              />
            ))}
          </>
        )}
      </Secao>

      {/* Chave por imóvel: abrir a seção num imóvel não consulta as imagens de todos os que vierem depois. */}
      <Secao titulo="Compare images" chave={`Comparar imagens ${i.cod_imovel}`} preguicosa
        info="Before and after images of a MapBiomas alert side by side on the map, with a draggable divider.">
        <CompararImagens cod={i.cod_imovel} />
      </Secao>

      <Secao titulo="Database history" extra={<span className="nt-data">{i.versoes.length} {i.versoes.length === 1 ? 'version' : 'versions'}</span>}>
        {i.versoes.map((v) => (
          <Linha
            key={v.valido_de}
            status={v.conformidade}
            titulo={v.valido_ate ? `${fmtDataAno(v.valido_de)} to ${fmtDataAno(v.valido_ate)}` : `Since ${fmtDataAno(v.valido_de)}`}
            sub={`${v.condicao} · ${haInteiro(v.area_ha)} · load ${v.carga_id}`}
          />
        ))}
      </Secao>
    </>
  )
}
