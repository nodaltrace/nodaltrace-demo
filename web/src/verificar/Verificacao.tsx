import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useApi } from '../api/cliente'
import type { Saude, Status, Verificacao as VerificacaoApi } from '../api/tipos'
import { FormaStatus } from '../components/FormaStatus'
import { Marca } from '../components/Marca'
import { useDica } from '../components/ui'
import { STATUS } from '../formato'
import type { Item } from '../atestacao/merkle'
import { avisoDeAtraso, camposEsperados, conferirCampos, lerArquivo, urlExplorer, type ArquivoLido } from '../atestacao/relatorio'
import './verificar.css'

const RPC = (import.meta.env.VITE_SOLANA_RPC as string | undefined) || 'https://api.devnet.solana.com'
const hostRpc = (() => { try { return new URL(RPC).host } catch { return RPC } })()
/** A identidade pública do NodalTrace na rede, fixada no build: a página não depende da API para saber quem registrou. */
const AUTORIDADE_BUILD = (import.meta.env.VITE_NT_AUTORIDADE as string | undefined) || ''

const encurtar = (s: string, n = 10) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s)
const dfHora = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
const fmtHora = (iso: unknown) => {
  const d = new Date(typeof iso === 'string' ? iso : NaN)
  return Number.isNaN(d.getTime()) ? '—' : `${dfHora.format(d)} UTC`
}
/** Texto de um valor do arquivo (dado não confiável): sempre string, nunca HTML. */
const tx = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))
const statusDe = (v: unknown): Status | null => (typeof v === 'string' && v in STATUS ? (v as Status) : null)

type Lido = { arquivo: ArquivoLido; nome: string } | { erro: string; nome: string }

/** Lê a conta do relatório no RPC. O módulo da rede (@solana/kit) só carrega aqui, sob demanda. */
function useRegistroNaRede(serie: string | undefined, numero: number | undefined, autoridade: string) {
  return useQuery({
    queryKey: ['registro-solana', RPC, autoridade, serie, numero],
    queryFn: async () => (await import('../atestacao/rede')).lerRegistro({ rpc: RPC, autoridade, serie: serie!, numero: numero! }),
    enabled: !!serie && !!numero && !!autoridade,
    staleTime: Infinity,
    retry: 1,
  })
}

function Ok({ ok }: { ok: boolean }) {
  return ok ? <b className="vf-ok">pass</b> : <b className="vf-bad">fail</b>
}

/**
 * Página pública de verificação de um relatório (docs/atestacao/CONTRATO.md). Com o arquivo do relatório (o documento
 * inteiro ou uma prova parcial), recalcula a raiz de Merkle no navegador e a confere com a conta do relatório na Solana,
 * lida direto do RPC. Pelo endereço /verificar/<id>, mostra também o que o NodalTrace informa do registro.
 */
export function Verificacao({ id }: { id: string | null }) {
  const api = useApi<VerificacaoApi>(id ? `/verificacao/${encodeURIComponent(id)}` : null)
  const saude = useApi<Saude>('/saude')
  const [lido, setLido] = useState<Lido | null>(null)
  const [arrastando, setArrastando] = useState(false)

  const arquivo = lido && 'arquivo' in lido ? lido.arquivo : null
  const autoridadeApi = api.data?.rede.autoridade || saude.data?.ancoragem.rede.autoridade || ''
  const autoridade = AUTORIDADE_BUILD || autoridadeApi
  const serie = arquivo?.cabecalho.serie ?? api.data?.serie
  const numero = arquivo?.cabecalho.numero ?? api.data?.numero
  const rede = useRegistroNaRede(serie, numero, autoridade)
  const cluster = api.data?.rede.cluster ?? saude.data?.ancoragem.rede.cluster ?? 'devnet'

  const abrir = async (f: File | undefined) => {
    if (!f) return
    const texto = await f.text()
    try {
      setLido({ arquivo: lerArquivo(texto), nome: f.name })
    } catch (e) {
      setLido({ erro: (e as Error).message, nome: f.name })
    }
  }

  const esperado = arquivo ? camposEsperados(arquivo) : null
  const conferencias = esperado && rede.data ? conferirCampos(esperado, rede.data.campos) : null
  const estrutura = rede.data?.checagens.every((c) => c.ok) ?? false
  const confere = !!conferencias && conferencias.every((c) => c.ok) && estrutura && arquivo!.problemas.length === 0
  const semConta = rede.data && !rede.data.campos
  const atraso = rede.data?.campos ? avisoDeAtraso(rede.data.campos.issued_at, rede.data.blocoEm) : null
  const [dicaMarca, balaoMarca] = useDica<HTMLAnchorElement>('Open the NodalTrace map', 'baixo')

  return (
    <div className="nt vf">
      <header className="vf-topo">
        <a href="/" {...dicaMarca}><Marca /></a>
        {balaoMarca}
        <span className="nt-data">Report verification · Solana {cluster}</span>
      </header>

      <main className="vf-corpo">
        <p className="vf-sobre nt-data">{id ? `Report ${id}` : 'NodalTrace analysis report'}</p>
        <h1>
          {!arquivo ? (
            'Verify a report'
          ) : rede.isLoading ? (
            <span className="vf-resultado">Checking on-chain…</span>
          ) : confere ? (
            <span className="vf-resultado vf-resultado--ok"><FormaStatus status="conforme" />The document matches its Solana registration</span>
          ) : semConta ? (
            <span className="vf-resultado vf-resultado--parcial"><FormaStatus status="atencao" />Registration not found on-chain</span>
          ) : (
            <span className="vf-resultado vf-resultado--bad"><FormaStatus status="nao_conforme" />The document does not match its registration</span>
          )}
        </h1>
        <p className="vf-lede">
          This page checks, in your browser, whether a report file is the same one NodalTrace registered on Solana when the
          report was issued. The Merkle root is recomputed here and the account is read directly from the network ({hostRpc}),
          without going through NodalTrace's servers.
        </p>

        <label
          className={`vf-arquivo${arrastando ? ' vf-arquivo--sobre' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setArrastando(true) }}
          onDragLeave={() => setArrastando(false)}
          onDrop={(e) => { e.preventDefault(); setArrastando(false); abrir(e.dataTransfer.files[0]) }}
        >
          <input type="file" accept="application/json,.json" onChange={(e) => abrir(e.target.files?.[0])} />
          <strong>{lido ? lido.nome : 'Drop the report document (.json) or a partial proof here'}</strong>
          <span>or click to choose the file. It never leaves your computer.</span>
        </label>
        {lido && 'erro' in lido && <p className="vf-aviso">Not a NodalTrace report: {lido.erro}</p>}
        {arquivo && id && arquivo.cabecalho.relatorio !== id && (
          <p className="vf-aviso">The file belongs to report {arquivo.cabecalho.relatorio}, not {id}: the check below is for that report.</p>
        )}
        {!AUTORIDADE_BUILD && autoridadeApi && (
          <p className="vf-aviso">This page has no authority pinned at build time: it uses the one the API reports ({encurtar(autoridadeApi)}). Check it against the one NodalTrace publishes.</p>
        )}
        {AUTORIDADE_BUILD && autoridadeApi && autoridadeApi !== AUTORIDADE_BUILD && (
          <p className="vf-aviso">The API reports a different authority ({encurtar(autoridadeApi)}); the one pinned in this page prevails.</p>
        )}
        {!autoridade && <p className="vf-aviso">Without the NodalTrace authority, the on-chain account cannot be found.</p>}

        {api.data && <RegistroInformado v={api.data} cluster={cluster} />}
        {id && api.error && <p className="vf-aviso">NodalTrace did not return this report ({api.error.message}). With the file, the on-chain check still works.</p>}

        {(arquivo || api.data) && (
          <section className="nt-card">
            <h2>On-chain</h2>
            {rede.error && <p className="vf-bad">Could not read the network: {(rede.error as Error).message}</p>}
            {rede.data && (
              <>
                <dl className="vf-registro">
                  <dt>Report account</dt>
                  <dd className="nt-data"><a href={urlExplorer('address', rede.data.conta, cluster)} target="_blank" rel="noreferrer">{rede.data.conta}</a></dd>
                  {rede.data.transacao && (
                    <>
                      <dt>Transaction that created it</dt>
                      <dd className="nt-data"><a href={urlExplorer('tx', rede.data.transacao, cluster)} target="_blank" rel="noreferrer">{encurtar(rede.data.transacao, 16)}</a></dd>
                      <dt>Block</dt>
                      <dd>{fmtHora(rede.data.blocoEm)} · slot {rede.data.slot}</dd>
                    </>
                  )}
                  {rede.data.assinante && (
                    <>
                      <dt>Signed by</dt>
                      <dd className="nt-data">
                        {rede.data.assinante}{' '}
                        <small>{rede.data.assinanteAtual ? '(authorized signer of the credential)' : "(no longer the credential's signer: registrations made before the key change remain valid)"}</small>
                      </dd>
                    </>
                  )}
                  <dt>NODALTRACE credential</dt>
                  <dd className="nt-data">{rede.data.credencial} <small>of authority {encurtar(autoridade)}</small></dd>
                </dl>
                {atraso && <p className="vf-aviso">{atraso}</p>}
                {api.data && rede.data.campos && !arquivo && (
                  <p className={rede.data.campos.root === api.data.raiz ? 'vf-ok' : 'vf-bad'}>
                    {rede.data.campos.root === api.data.raiz
                      ? 'The root registered on-chain is the one NodalTrace reports. To check the contents, open the report file above.'
                      : 'The root registered on-chain differs from the one NodalTrace reports.'}
                  </p>
                )}
                {conferencias && (
                  <div className="vf-rolagem">
                    <table className="nt-table">
                      <thead><tr><th>Field</th><th>In the file</th><th>On-chain</th><th /></tr></thead>
                      <tbody>
                        {conferencias.map((c) => (
                          <tr key={c.campo}>
                            <td>{c.rotulo}</td>
                            <td className="nt-data">{encurtar(String(c.esperado), 12)}</td>
                            <td className="nt-data">{c.lido === null ? '—' : encurtar(String(c.lido), 12)}</td>
                            <td><Ok ok={c.ok} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <ul className="vf-checagens">
                  {rede.data.checagens.map((c, n) => (
                    <li key={n}><Ok ok={c.ok} /> {c.rotulo}{c.detalhe && <small className="nt-data"> · {encurtar(c.detalhe, 14)}</small>}</li>
                  ))}
                  {arquivo?.problemas.map((p, n) => <li key={`p${n}`}><b className="vf-bad">file</b> {p}</li>)}
                </ul>
              </>
            )}
          </section>
        )}

        {arquivo && <Conteudo a={arquivo} />}

        <section className="nt-card nt-card--flat">
          <h2>What this page proves</h2>
          <p>
            That the contents of the file are exactly what NodalTrace registered on Solana, with its credential, at the time of
            the block: any change to the verdict, the data, the data sources or the rules version changes the Merkle root. A
            partial proof reveals only the chosen properties; the others stay hidden, and the root still matches.
          </p>
          <p>
            It does not prove that the analysis is right or that the data sources were right: the report states which data
            sources and rules it used, and the facts behind each result (such as the MapBiomas alert ids) can be checked at
            the sources. A corrected report never changes: the correction is another report, also registered, that states
            which one it supersedes.
          </p>
          {cluster === 'devnet' && <p className="vf-aviso">Registrations are on devnet, the Solana test network, which does not guarantee that history is kept.</p>}
        </section>
      </main>
      <footer className="vf-rodape nt-data">NodalTrace · {hostRpc}</footer>
    </div>
  )
}

/** O que o NodalTrace informa do registro (GET /verificacao/{id}): só os dados do registro, nada dos imóveis. */
function RegistroInformado({ v, cluster }: { v: VerificacaoApi; cluster: string }) {
  const r = v.registro
  return (
    <section className="nt-card">
      <h2>Registration reported by NodalTrace</h2>
      {v.substituido_por && (
        <p className="vf-aviso">
          Superseded by report <a href={`/verificar/${encodeURIComponent(v.substituido_por.relatorio)}`}>{v.substituido_por.relatorio}</a> on{' '}
          {fmtHora(v.substituido_por.emitido_em)}: {v.substituido_por.motivo}
        </p>
      )}
      <dl className="vf-registro">
        <dt>Report</dt>
        <dd className="nt-data">{v.relatorio} · series {encurtar(v.serie, 8)} · number {v.numero}</dd>
        <dt>Issued on</dt>
        <dd>{fmtHora(v.emitido_em)} · rules {v.regras}</dd>
        {v.substitui && (
          <>
            <dt>Supersedes</dt>
            <dd><a href={`/verificar/${encodeURIComponent(v.substitui)}`}>{v.substitui}</a></dd>
          </>
        )}
        <dt>Merkle root</dt>
        <dd className="nt-data">{v.raiz}</dd>
        <dt>On-chain registration</dt>
        <dd>
          {r.status === 'confirmada'
            ? <>confirmed on {fmtHora(r.bloco_em)}{r.transacao && <> · <a href={urlExplorer('tx', r.transacao, cluster)} target="_blank" rel="noreferrer">transaction</a></>}</>
            : r.status === 'falhou' ? <span className="vf-bad">rejected by the network</span> : 'not confirmed yet (registration happens right after issuance)'}
        </dd>
      </dl>
    </section>
  )
}

/** O conteúdo que o arquivo revela: o cabeçalho, o resumo (se veio) e os imóveis. */
function Conteudo({ a }: { a: ArquivoLido }) {
  const c = a.cabecalho
  const resumo = a.itens.find((i) => i.tipo === 'resumo')
  const imoveis = a.itens.filter((i) => i.tipo === 'imovel')
  const nomes = Object.fromEntries((Array.isArray(c.analises) ? c.analises : []).map((x) => [x.id, x.nome]))
  return (
    <section className="nt-card">
      <h2>Contents of the {a.tipo === 'prova' ? 'file (partial proof)' : 'document'}</h2>
      <dl className="vf-registro">
        <dt>Report</dt>
        <dd className="nt-data">{tx(c.relatorio)} · issued on {fmtHora(c.emitido_em)} · rules {tx(c.regras.versao)}</dd>
        {c.substitui && (
          <>
            <dt>Supersedes</dt>
            <dd>{tx(c.substitui.relatorio)}: {tx(c.substitui.motivo)}</dd>
          </>
        )}
        <dt>Analyses</dt>
        <dd>{Object.values(nomes).map(tx).join(' · ') || '—'}</dd>
        {resumo && (
          <>
            <dt>Report verdict</dt>
            <dd>{STATUS[statusDe(resumo.status) ?? 'pendente'].rotulo} · {tx(resumo.imoveis)} {resumo.imoveis === 1 ? 'property' : 'properties'}</dd>
          </>
        )}
      </dl>
      {a.tipo === 'prova' && <p className="vf-sobre">{imoveis.length} {imoveis.length === 1 ? 'property revealed' : 'properties revealed'}; the other properties in the report stay hidden.</p>}
      {imoveis.map((i) => <ImovelRevelado key={i.id} i={i} nomes={nomes} />)}
    </section>
  )
}

function ImovelRevelado({ i, nomes }: { i: Item; nomes: Record<string, string> }) {
  const status = statusDe(i.status)
  const resultados = Array.isArray(i.resultados) ? (i.resultados as Record<string, unknown>[]) : []
  return (
    <details className="vf-itens" open>
      <summary>
        {status && <FormaStatus status={status} tamanho={12} />} <span className="nt-data">{i.id}</span> · {tx(i.municipio)} · {status ? STATUS[status].rotulo : tx(i.status)}
      </summary>
      <ul className="vf-checagens">
        {resultados.map((r, n) => {
          const s = statusDe(r.status)
          return <li key={n}><b>{s ? STATUS[s].rotulo : 'Informational'}</b> {nomes[tx(r.analise)] ?? tx(r.analise)}: {tx(r.resumo)}</li>
        })}
      </ul>
    </details>
  )
}
