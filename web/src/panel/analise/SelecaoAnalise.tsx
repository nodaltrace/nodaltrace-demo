import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { chaveApi, enviar, queryClient, urlApi } from '../../api/cliente'
import { useCatalogoAnalises, useRelatorio, useRelatorios, useResumoImoveis } from '../../api/hooks'
import type { BaseRelatorio, ImovelRelatorio, ImovelResumo, ProvaRelatorio, Relatorio, ResultadoAnalise } from '../../api/tipos'
import { urlExplorer } from '../../atestacao/relatorio'
import { FormaStatus } from '../../components/FormaStatus'
import { Icone } from '../../components/icones'
import { Badge, BotaoIcone, Carregando, Indicador, Linha, Secao, useDica } from '../../components/ui'
import { ORDEM_STATUS, STATUS, fmtDataAno, fmtDatasBase, fmtDiaBrasilia, fmtHa, fmtNum } from '../../formato'
import { camera } from '../../map/camera'
import { abrirRelatorio, corrigirRelatorio, novaSelecao } from '../../store/acoes'
import { enquadrarAoAbrir, navegar, useRota, voltarPara } from '../../store/rota'
import { MAX_IMOVEIS_ANALISE, useSelecao } from '../../store/selecao'

// A mesma chave que o useApi monta: o relatório emitido já entra no cache.
const chaveRelatorio = (id: string) => chaveApi(`/relatorios/${encodeURIComponent(id)}`)
const dfHora = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })

/** O retângulo [oeste, sul, leste, norte] que contém todos os outros. */
const caixaDe = (limites: [number, number, number, number][]): [number, number, number, number] => [
  Math.min(...limites.map((l) => l[0])),
  Math.min(...limites.map((l) => l[1])),
  Math.max(...limites.map((l) => l[2])),
  Math.max(...limites.map((l) => l[3])),
]

/**
 * Seleção para análise, em três etapas, cada uma com o seu endereço (store/rota.ts): montar a lista de imóveis (clique
 * no mapa ou busca pelo código), escolher as análises do catálogo e ver o relatório emitido, com o registro na Solana, o
 * documento e o PDF. A correção de um relatório passa pelas mesmas etapas, com a lista dele e um motivo.
 */
export function SelecaoAnalise() {
  const rota = useRota((s) => s.rota)
  // Nulo: todas as análises disponíveis, inclusive as que entrarem no catálogo depois.
  const [escolhidas, setEscolhidas] = useState<Set<string> | null>(null)
  if (rota.tela === 'relatorio') return <EtapaResultado key={rota.id} rid={rota.id} />
  if (rota.tela === 'analises') return <EtapaAnalises escolhidas={escolhidas} setEscolhidas={setEscolhidas} />
  return <EtapaSelecao />
}

// --- 1. imóveis ------------------------------------------------------------------------------------

function EtapaSelecao() {
  const imoveis = useSelecao((s) => s.imoveis)
  const alternar = useSelecao((s) => s.alternar)
  const limpar = useSelecao((s) => s.limpar)
  const correcao = useSelecao((s) => s.correcao)
  const { porCod, carregando, erro } = useResumoImoveis(imoveis)
  const fichas = imoveis.flatMap((c) => porCod.get(c) ?? [])
  const ausentes = imoveis.filter((c) => porCod.get(c) === null)
  const area = fichas.reduce((s, f) => s + (f.area_ha ?? 0), 0)
  const pronto = imoveis.length > 0 && !carregando && ausentes.length === 0

  return (
    <>
      <div className="painel-corpo">
        <div className="titulo">
          <span className="etiqueta">Analysis selection</span>
          <h2>{imoveis.length === 0 ? 'No properties selected' : `${imoveis.length} ${imoveis.length === 1 ? 'property selected' : 'properties selected'}`}</h2>
          {imoveis.length > 0 && !carregando && <span className="nt-data">{fmtHa(area)} total</span>}
        </div>
        {correcao && <AvisoCorrecao relatorio={correcao.relatorio} />}

        {imoveis.length === 0 ? (
          <>
            <ol className="passos">
              <li>Click CAR properties on the map to add them to the analysis; click again to remove one. Property boundaries appear from zoom 8.</li>
              <li>You can also search by CAR code in the box above.</li>
              <li>Once the list is ready, choose the analyses and issue the report.</li>
            </ol>
            <RelatoriosEmitidos />
          </>
        ) : (
          <>
            {erro && <p className="aviso">Couldn't load the properties: {erro.message}</p>}
            {ausentes.length > 0 && (
              <p className="nota txt-bad">{ausentes.length === 1 ? 'One code is not in the CAR database. Remove it to continue.' : `${ausentes.length} codes are not in the CAR database. Remove them to continue.`}</p>
            )}
            <div className="lista-sel">
              {imoveis.map((cod, n) => <ItemSelecao key={cod} cod={cod} n={n} ficha={porCod.get(cod)} retirar={() => alternar(cod)} />)}
            </div>
            <div className="acoes">
              {fichas.length > 0 && (
                <button className="nt-btn nt-btn--outline nt-btn--sm" onClick={() => camera.mostrar(caixaDe(fichas.map((f) => f.limites)))}>Show all on map</button>
              )}
              <button className="nt-btn nt-btn--perigo nt-btn--sm" onClick={limpar}>Clear selection</button>
            </div>
            {imoveis.length >= MAX_IMOVEIS_ANALISE && <p className="nota">Limit of {MAX_IMOVEIS_ANALISE} properties per report.</p>}
          </>
        )}
      </div>
      <footer className="painel-rodape">
        <button className="nt-btn nt-btn--primary" disabled={!pronto} onClick={() => navegar({ tela: 'analises' })}>
          {imoveis.length ? `Continue (${imoveis.length})` : 'Continue'}
        </button>
      </footer>
    </>
  )
}

/** Um imóvel da lista da seleção: o clique leva o mapa até ele; o × o retira. */
function ItemSelecao({ cod, n, ficha: f, retirar }: { cod: string; n: number; ficha: ImovelResumo | null | undefined; retirar: () => void }) {
  const [dica, balao] = useDica<HTMLButtonElement>('Show on map', 'cima')
  return (
    <div className="item-sel">
      <button className="item-sel-corpo" onClick={() => f && camera.mostrar(f.limites)} disabled={!f} {...(f && dica)}>
        <span className="item-sel-n nt-data">{n + 1}</span>
        {f ? <FormaStatus status={f.conformidade} tamanho={13} /> : <span className="item-sel-vazio" />}
        <span className="linha-tx">
          <strong className="nt-data">{cod}</strong>
          <small>
            {f
              ? `${f.municipio} · ${f.uf} · ${fmtHa(f.area_ha)} · ${f.situacao_rotulo} CAR${f.vigente ? '' : ' (not in SICAR)'}`
              : f === null ? 'CAR not found in the database' : 'Loading…'}
          </small>
        </span>
      </button>
      {balao}
      <BotaoIcone rotulo="Remove from selection" lado="esquerda" className="item-sel-retirar" onClick={retirar}>
        ×
      </BotaoIcone>
    </div>
  )
}

/** Relatórios emitidos mais recentes: abrir um mostra o resultado e o documento oficial. */
export function RelatoriosEmitidos() {
  const { data } = useRelatorios()
  if (!data?.length) return null
  return (
    <Secao titulo="Issued reports">
      {data.map((r) => (
        <Linha
          key={r.id}
          status={r.status}
          titulo={<span className="nt-data">{r.id}</span>}
          sub={`${fmtDataAno(r.emitido_em)} · ${r.imoveis} ${r.imoveis === 1 ? 'property' : 'properties'} · ${r.analises} ${r.analises === 1 ? 'analysis' : 'analyses'} · ${REGISTRO[r.ancoragem]}${r.substituido_por ? ` · replaced by ${r.substituido_por}` : ''}`}
          aoClicar={() => abrirRelatorio(r.id)}
        />
      ))}
    </Secao>
  )
}

/** O registro na Solana, em poucas palavras. */
const REGISTRO: Record<Relatorio['ancoragem']['status'], string> = { pendente: 'registering', enviando: 'registering', confirmada: 'on Solana', falhou: 'registration rejected' }

function AvisoCorrecao({ relatorio }: { relatorio: string }) {
  const cancelar = useSelecao((s) => s.cancelarCorrecao)
  return (
    <div className="aviso">
      <Icone.alerta />
      <div>
        <strong>Correction of report {relatorio}</strong>
        <p>The new report replaces {relatorio}, which stays stored and registered on Solana and will point to the correction.</p>
        <button className="nt-btn nt-btn--outline nt-btn--sm" onClick={cancelar}>Cancel correction</button>
      </div>
    </div>
  )
}

// --- 2. análises -----------------------------------------------------------------------------------

function EtapaAnalises({ escolhidas, setEscolhidas }: { escolhidas: Set<string> | null; setEscolhidas: (s: Set<string> | null) => void }) {
  const imoveis = useSelecao((s) => s.imoveis)
  const correcao = useSelecao((s) => s.correcao)
  const [motivo, setMotivo] = useState('')
  const aSelecao = () => voltarPara({ tela: 'selecao' })
  const { data: catalogo, error } = useCatalogoAnalises()
  const todas = useRef<HTMLInputElement>(null)

  const disponiveis = catalogo?.filter((a) => a.disponivel) ?? []
  // Na correção, vêm marcadas as análises do relatório corrigido.
  const marcadas = disponiveis.filter((a) => (escolhidas ? escolhidas.has(a.id) : correcao ? correcao.analises.includes(a.id) : true)).map((a) => a.id)
  const motivoOk = !correcao || motivo.trim().length >= 10
  const tudo = marcadas.length === disponiveis.length && disponiveis.length > 0

  useEffect(() => {
    if (todas.current) todas.current.indeterminate = marcadas.length > 0 && !tudo
  }, [marcadas.length, tudo])

  const alternar = (id: string) => {
    const s = new Set(marcadas)
    if (s.has(id)) s.delete(id)
    else s.add(id)
    setEscolhidas(s.size === disponiveis.length ? null : s)
  }

  const emitir = useMutation({
    mutationFn: () =>
      enviar<Relatorio>('/relatorios', { imoveis, analises: marcadas, ...(correcao && { substitui: correcao.relatorio, motivo: motivo.trim() }) }),
    onSuccess: (r) => {
      queryClient.setQueryData(chaveRelatorio(r.id), r)
      queryClient.invalidateQueries({ queryKey: ['/relatorios'] })
      if (correcao) {
        // O corrigido passa a mostrar o que o substitui.
        queryClient.invalidateQueries({ queryKey: chaveRelatorio(correcao.relatorio) })
        useSelecao.getState().cancelarCorrecao()
      }
      // No lugar da escolha das análises: voltar do relatório leva à lista de imóveis.
      abrirRelatorio(r.id, { substituir: true })
    },
  })

  return (
    <>
      <div className="painel-corpo">
        <div className="migalha">
          <button className="nt-btn nt-btn--outline nt-btn--sm" onClick={aSelecao}><Icone.voltar /> Properties</button>
        </div>
        <div className="titulo">
          <span className="etiqueta">Analysis selection</span>
          <h2>Which analyses to run?</h2>
          <span className="nt-data">{imoveis.length} {imoveis.length === 1 ? 'property' : 'properties'}</span>
        </div>
        {correcao && (
          <>
            <AvisoCorrecao relatorio={correcao.relatorio} />
            <label className="campo-motivo">
              <strong>Reason for the correction</strong>
              <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={500} rows={3}
                placeholder="What was wrong in the previous report (goes into the record, 10 to 500 characters)" />
            </label>
          </>
        )}

        {error ? (
          <Carregando erro={error} />
        ) : !catalogo ? (
          <Carregando />
        ) : (
          <div className="analises">
            <label className="analise analise--todas">
              <input ref={todas} type="checkbox" checked={tudo} onChange={() => setEscolhidas(tudo ? new Set() : null)} disabled={!disponiveis.length} />
              <span className="analise-tx"><strong>Select all</strong><small>{marcadas.length} of {disponiveis.length} available</small></span>
            </label>
            {catalogo.map((a) => (
              <label key={a.id} className={`analise${a.disponivel ? '' : ' analise--off'}`}>
                <input type="checkbox" checked={a.disponivel && marcadas.includes(a.id)} disabled={!a.disponivel} onChange={() => alternar(a.id)} />
                <span className="analise-tx">
                  <strong>{a.nome}</strong>
                  <small>{a.descricao}</small>
                  <small className="analise-base">{a.base ?? 'Unavailable: the data for this analysis is not loaded in the database yet.'}</small>
                </span>
              </label>
            ))}
          </div>
        )}
        {emitir.error && (
          <div className="aviso">
            <Icone.alerta />
            <div><strong>Couldn't issue the report</strong><p>{emitir.error.message}</p></div>
          </div>
        )}
      </div>
      <footer className="painel-rodape">
        <button className="nt-btn nt-btn--outline" onClick={aSelecao}>Back</button>
        <button className="nt-btn nt-btn--primary" disabled={!marcadas.length || !motivoOk || emitir.isPending} onClick={() => emitir.mutate()}>
          {emitir.isPending ? 'Analyzing…' : correcao ? 'Issue correction' : `Run ${marcadas.length} ${marcadas.length === 1 ? 'analysis' : 'analyses'}`}
        </button>
      </footer>
    </>
  )
}

// --- 3. resultado ----------------------------------------------------------------------------------

function EtapaResultado({ rid }: { rid: string }) {
  const { data: r, error } = useRelatorio(rid)
  // Aberto por um endereço sem enquadramento (um link compartilhado): o mapa enquadra os imóveis do relatório.
  useEffect(() => {
    if (r && enquadrarAoAbrir()) camera.limites(caixaDe(r.imoveis.map((i) => i.limites)))
  }, [r])

  if (!r) return <div className="painel-corpo"><Carregando erro={error} /></div>
  const nomes = Object.fromEntries(r.analises.map((a) => [a.id, a.nome]))

  return (
    <>
      <div className="painel-corpo">
        <div className="titulo">
          <span className="etiqueta">Analysis report · <span className="nt-data">{r.id}</span></span>
          <h2>Analysis result</h2>
          <Badge status={r.status} />
        </div>
        <div className="indicadores">
          {ORDEM_STATUS.map((s) => (
            <Indicador key={s} status={s} rotulo={STATUS[s].rotulo} valor={fmtNum(r.resumo[s])} colorir={r.resumo[s] > 0} ir="Properties" />
          ))}
        </div>
        <p className="nota nota--relatorio">
          Issued on {dfHora.format(new Date(r.emitido_em))} · {r.analises.length} {r.analises.length === 1 ? 'analysis' : 'analyses'}:{' '}
          {r.analises.map((a) => a.nome).join(', ')}.
        </p>
        {r.substituido_por && (
          <div className="aviso">
            <Icone.alerta />
            <div>
              <strong>Replaced by report {r.substituido_por.relatorio}</strong>
              <p>On {dfHora.format(new Date(r.substituido_por.emitido_em))}: {r.substituido_por.motivo}</p>
              <button className="nt-btn nt-btn--outline nt-btn--sm" onClick={() => abrirRelatorio(r.substituido_por!.relatorio)}>Open {r.substituido_por.relatorio}</button>
            </div>
          </div>
        )}
        {r.substitui && (
          <p className="nota">
            Corrects report <button className="link" onClick={() => abrirRelatorio(r.substitui!.relatorio)}>{r.substitui.relatorio}</button>: {r.substitui.motivo}
          </p>
        )}

        <Secao titulo="Data sources" extra={<span className="nt-data">{r.bases.length}</span>}>
          <p className="nota">The report is from {fmtDiaBrasilia(r.emitido_em)}; each source's data runs through the date shown, taken from the data itself.</p>
          {r.bases.map((b) => <Linha key={`${b.fonte}-${b.uf ?? ''}`} icone={b.fonte === 'mapbiomas' ? <Icone.alerta /> : <Icone.mapa />} titulo={[b.nome, b.uf, b.versao].filter(Boolean).join(' · ')} sub={datasDaBase(b)} />)}
        </Secao>

        <Secao titulo="Properties" aberta extra={<button className="nt-btn nt-btn--outline nt-btn--sm" onClick={() => camera.mostrar(caixaDe(r.imoveis.map((i) => i.limites)))}>Show all on map</button>}>
          {r.imoveis.map((i) => <CartaoImovel key={i.cod_imovel} rid={r.id} imovel={i} nomes={nomes} aberto={r.imoveis.length <= 3} />)}
        </Secao>

        <RegistroSolana r={r} />

        {!r.substituido_por && (
          <Secao titulo="Correction">
            <p className="nota">
              Found a mistake? An issued report never changes: issue another one that corrects it. This one stays stored and registered,
              and will point to the correction.
            </p>
            <button className="nt-btn nt-btn--outline" onClick={() => corrigirRelatorio(r)}>Issue correction</button>
          </Secao>
        )}
      </div>
      <footer className="painel-rodape">
        <button className="nt-btn nt-btn--outline" onClick={novaSelecao}>New selection</button>
        <a className="nt-btn nt-btn--primary" href={urlApi(`/relatorios/${encodeURIComponent(r.id)}/pdf`)} download={`relatorio-${r.id}.pdf`}>
          Download official report (PDF)
        </a>
      </footer>
    </>
  )
}

/** O registro do relatório na Solana: o estado do envio, a raiz, onde conferir na rede e a página de verificação. */
function RegistroSolana({ r }: { r: Relatorio }) {
  const a = r.ancoragem
  const cluster = a.cluster ?? 'devnet'
  const [dicaDocumento, balaoDocumento] = useDica<HTMLAnchorElement>('The document registered on Solana: with it, anyone can check the report on the verification page')
  return (
    <Secao titulo="Solana registration" aberta>
      {a.status === 'confirmada' ? (
        <p className="nota nota--ok">
          Registered on Solana ({cluster}){a.bloco_em && ` on ${dfHora.format(new Date(a.bloco_em))}`}: the root below is on-chain and can no longer change.
        </p>
      ) : a.status === 'falhou' ? (
        <div className="aviso"><Icone.alerta /><div><strong>The network rejected the registration</strong><p>{a.erro}</p></div></div>
      ) : (
        <p className="nota">Registering on Solana…{a.erro && ` Last attempt: ${a.erro}. The next one runs automatically.`}</p>
      )}
      <span className="rotulo-hash">Document Merkle root</span>
      <p className="nt-hash">{r.raiz}</p>
      <p className="nota">Number {r.numero} in series <span className="nt-data">{r.serie.slice(0, 8)}</span> · rules {r.regras.versao}</p>
      {!r.integro && (
        <div className="aviso"><Icone.alerta /><div><strong>The stored record doesn't match the root it was issued with</strong><p>The document was altered after it was issued.</p></div></div>
      )}
      <div className="acoes">
        <a className="nt-btn nt-btn--outline nt-btn--sm" href={urlApi(`/relatorios/${encodeURIComponent(r.id)}/documento`)} download={`relatorio-${r.id}.json`} {...dicaDocumento}>
          <Icone.baixar /> Document (JSON)
        </a>
        {balaoDocumento}
        {a.conta && <a className="nt-btn nt-btn--outline nt-btn--sm" href={urlExplorer('address', a.conta, cluster)} target="_blank" rel="noreferrer">On-chain account <Icone.externo /></a>}
        {a.transacao && <a className="nt-btn nt-btn--outline nt-btn--sm" href={urlExplorer('tx', a.transacao, cluster)} target="_blank" rel="noreferrer">Transaction <Icone.externo /></a>}
        <a className="nt-btn nt-btn--outline nt-btn--sm" href={`/verificar/${encodeURIComponent(r.id)}`} target="_blank" rel="noreferrer">Verification page <Icone.externo /></a>
      </div>
    </Secao>
  )
}

/** Baixa a prova parcial de um imóvel: o cabeçalho e o imóvel, com os hashes até a raiz registrada na Solana. */
async function baixarProva(rid: string, cod: string) {
  const p = await enviar<ProvaRelatorio>(`/relatorios/${encodeURIComponent(rid)}/prova`, { imoveis: [cod] })
  const url = URL.createObjectURL(new Blob([JSON.stringify(p)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `prova-${rid}-${cod}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/** O que `dados_ate` mede em cada base. */
const DADOS_ATE: Record<BaseRelatorio['fonte'], string> = { sicar: 'updates', mapbiomas: 'detections', bioma: 'data', embargo: 'data' }

/** Base sem data por registro (os biomas do IBGE): só a carga, a edição já vai no título. */
const datasDaBase = (b: BaseRelatorio) =>
  b.dados_ate || b.publicado_em ? fmtDatasBase(b, DADOS_ATE[b.fonte]) : `loaded ${fmtDiaBrasilia(b.carregado_em)}`

function CartaoImovel({ rid, imovel: i, nomes, aberto }: { rid: string; imovel: ImovelRelatorio; nomes: Record<string, string>; aberto: boolean }) {
  const prova = useMutation({ mutationFn: () => baixarProva(rid, i.cod_imovel) })
  const [dicaProva, balaoProva] = useDica<HTMLButtonElement>('Only this property and the hashes up to the root: verifiable on the verification page without revealing the other properties in the report')
  return (
    <details className={`resultado-imovel resultado-imovel--${i.status}`} open={aberto}>
      <summary>
        <FormaStatus status={i.status} tamanho={14} />
        <span className="linha-tx">
          <strong className="nt-data">{i.cod_imovel}</strong>
          <small>{i.municipio} · {i.uf} · {fmtHa(i.area_ha)} · {STATUS[i.status].rotulo}</small>
        </span>
      </summary>
      {i.resultados.map((res) => <LinhaResultado key={res.analise} res={res} nome={nomes[res.analise] ?? res.analise} />)}
      <div className="acoes">
        <button className="nt-btn nt-btn--outline nt-btn--sm" onClick={() => camera.mostrar(i.limites)}>Show on map</button>
        <button className="nt-btn nt-btn--outline nt-btn--sm" disabled={prova.isPending} onClick={() => prova.mutate()} {...dicaProva}>
          <Icone.baixar /> {prova.isPending ? 'Preparing…' : 'Proof for this property'}
        </button>
        {balaoProva}
      </div>
      {prova.error && <p className="nota txt-bad">Couldn't generate the proof: {prova.error.message}</p>}
    </details>
  )
}

function LinhaResultado({ res, nome }: { res: ResultadoAnalise; nome: string }) {
  return (
    <div className="criterio">
      {res.status ? <FormaStatus status={res.status} tamanho={14} /> : <span className="forma-info" aria-hidden />}
      <div>
        <strong>{nome}</strong> <small>{res.status ? STATUS[res.status].rotulo : 'Informational'}</small>
        <p>{res.resumo}</p>
        {res.detalhes.length > 0 && (
          <ul className="detalhes-res">
            {res.detalhes.map((d, n) => <li key={n}>{d}</li>)}
          </ul>
        )}
      </div>
    </div>
  )
}
