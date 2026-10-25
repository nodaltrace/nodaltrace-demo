import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as TeclaReact, type PointerEvent } from 'react'
import { Icone } from '../components/icones'
import { BotaoIcone, Linha, useDica } from '../components/ui'
import { abrirAnalise, abrirImovel, irParaInicio } from '../store/acoes'
import { LARGURA_MAXIMA, LARGURA_MINIMA, LARGURA_PADRAO, usePainel } from '../store/painel'
import { naAnalise, useRota, voltar } from '../store/rota'
import { useSelecao } from '../store/selecao'
import { SelecaoAnalise } from './analise/SelecaoAnalise'
import { DetalheImovel } from './detalhe/Imovel'
import { Inicio } from './Inicio'
import { Marca } from '../components/Marca'
import { PROXIMO, ROTULO_TEMA, useTema } from '../tema'

/** Formato do código do CAR (UF, município do IBGE, hash do SICAR): a busca só abre o que tem esta forma. */
const CAR = /^[A-Z]{2}-\d{7}-[0-9A-F]{8,}$/i

const DICA_CODIGO = 'Type the full CAR code, like RS-4311155-3908C21E…, or click a property on the map.'

/** Busca pelo código do CAR: abre o imóvel. */
function Resultados({ termo, aoEscolher }: { termo: string; aoEscolher: () => void }) {
  if (!CAR.test(termo)) return <p className="vazio">{DICA_CODIGO}</p>
  const cod = termo.toUpperCase()
  return (
    <div className="lista">
      <Linha
        icone={<Icone.mapa />}
        titulo={<span className="nt-data">{cod}</span>}
        sub="Open CAR property"
        aoClicar={() => {
          abrirImovel(cod)
          aoEscolher()
        }}
      />
    </div>
  )
}

/** Busca durante a seleção para análise: o código do CAR entra na seleção (ou sai, se já estiver nela). */
function BuscaSelecao({ termo, aoEscolher }: { termo: string; aoEscolher: () => void }) {
  const imoveis = useSelecao((s) => s.imoveis)
  const alternar = useSelecao((s) => s.alternar)
  const relatorio = useRota((s) => s.rota.tela === 'relatorio')
  const cod = termo.toUpperCase()
  if (relatorio) return <p className="vazio">This report has already been issued. Start a new selection to add properties.</p>
  if (!CAR.test(termo)) return <p className="vazio">{DICA_CODIGO}</p>
  const dentro = imoveis.includes(cod)
  return (
    <div className="lista">
      <Linha
        icone={<Icone.mapa />}
        titulo={<span className="nt-data">{cod}</span>}
        sub={dentro ? 'Remove from selection' : 'Add to analysis selection'}
        aoClicar={() => {
          alternar(cod)
          aoEscolher()
        }}
      />
    </div>
  )
}

/**
 * A borda direita do painel: arrastar muda a largura, guardada no navegador; duplo clique volta à padrão; com o foco,
 * as setas (com Shift, de 64 em 64 px).
 */
function AlcaLargura() {
  const largura = usePainel((s) => s.largura)
  const setLargura = usePainel((s) => s.setLargura)
  const [arrastando, setArrastando] = useState(false)
  const [dica, balao] = useDica<HTMLDivElement>('Drag to resize the panel (double-click: default width)', 'direita')
  const esquerda = (e: PointerEvent<HTMLDivElement>) => e.currentTarget.parentElement!.getBoundingClientRect().left
  const terminar = () => {
    setArrastando(false)
    document.body.classList.remove('redimensionando')
    setLargura(usePainel.getState().largura, true)
  }
  const tecla = (e: TeclaReact<HTMLDivElement>) => {
    const passo = e.shiftKey ? 64 : 16
    const nova = { ArrowLeft: largura - passo, ArrowRight: largura + passo, Home: LARGURA_MINIMA, End: LARGURA_MAXIMA }[e.key]
    if (nova === undefined) return
    e.preventDefault()
    setLargura(nova, true)
  }
  return (
    <>
      <div
        className={`painel-alca${arrastando ? ' painel-alca--ativa' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Panel width"
        aria-valuenow={largura}
        aria-valuemin={LARGURA_MINIMA}
        aria-valuemax={LARGURA_MAXIMA}
        tabIndex={0}
        {...dica}
        onPointerDown={(e) => {
          dica.onPointerDown()
          e.currentTarget.setPointerCapture(e.pointerId)
          document.body.classList.add('redimensionando')
          setArrastando(true)
          e.preventDefault()
        }}
        onPointerMove={(e) => arrastando && setLargura(e.clientX - esquerda(e))}
        onPointerUp={terminar}
        onPointerCancel={terminar}
        onDoubleClick={() => setLargura(LARGURA_PADRAO, true)}
        onKeyDown={tecla}
      />
      {balao}
    </>
  )
}

export function Painel() {
  const rota = useRota((s) => s.rota)
  const aberto = usePainel((s) => s.aberto)
  const alternar = usePainel((s) => s.alternar)
  const largura = usePainel((s) => s.largura)
  const tema = useTema((s) => s.tema)
  const setTema = useTema((s) => s.setTema)
  const [termo, setTermo] = useState('')
  const busca = useRef<HTMLInputElement>(null)
  const corpo = useRef<HTMLDivElement>(null)
  const selecaoAtiva = naAnalise(rota)
  const naSelecao = useSelecao((s) => s.imoveis.length)

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        busca.current?.focus()
      }
      if (e.key === 'Escape') setTermo('')
    }
    addEventListener('keydown', tecla)
    return () => removeEventListener('keydown', tecla)
  }, [])

  useEffect(() => {
    corpo.current?.scrollTo({ top: 0 })
  }, [rota])

  return (
    <aside className={`lateral${aberto ? '' : ' lateral--fechada'}`} style={{ '--painel-largura': `${largura}px` } as CSSProperties}>
      <nav className="trilho" aria-label="Sections">
        <span className="trilho-marca"><Marca tipo="simbolo" /></span>
        <BotaoIcone rotulo={aberto ? 'Collapse panel' : 'Expand panel'} lado="direita" onClick={alternar} className="trilho-recolher">
          <Icone.recolher />
        </BotaoIcone>
        <span className="trilho-sep" aria-hidden />
        {/* Uma seção por item. O início vale também para o detalhe de um imóvel; a análise, para as etapas dela e o relatório. */}
        <BotaoIcone rotulo="Home" lado="direita" className={selecaoAtiva ? '' : 'on'} onClick={irParaInicio} aria-current={selecaoAtiva ? undefined : 'page'}>
          <Icone.inicio />
        </BotaoIcone>
        <BotaoIcone
          rotulo={naSelecao ? `Analysis (${naSelecao} ${naSelecao === 1 ? 'property selected' : 'properties selected'})` : 'Analysis'}
          lado="direita"
          className={selecaoAtiva ? 'on' : ''}
          onClick={abrirAnalise}
          aria-current={selecaoAtiva ? 'page' : undefined}
        >
          <Icone.analise />
          {naSelecao > 0 && <span className="trilho-contagem nt-data" aria-hidden>{naSelecao}</span>}
        </BotaoIcone>
        <span className="trilho-fim" />
        <BotaoIcone rotulo={`${ROTULO_TEMA[tema]} (click for ${ROTULO_TEMA[PROXIMO[tema]].toLowerCase()})`} lado="direita" onClick={() => setTema(PROXIMO[tema])}>
          {tema === 'claro' ? <Icone.temaClaro /> : <Icone.temaEscuro />}
        </BotaoIcone>
      </nav>

      <div className="painel">
        <AlcaLargura />
        <header className="painel-topo">
          {/* Demo do hackathon: "(demo)" logo depois do nome, para a demo não passar pelo produto. */}
          <span className="marca-demo">
            <Marca tipo="nome" />
            <span>(demo)</span>
          </span>
        </header>
        <label className="busca">
          <Icone.busca />
          <input
            ref={busca}
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            placeholder={selecaoAtiva ? 'Add a property by CAR code…' : 'Search a property by CAR code…'}
          />
          <kbd>Ctrl K</kbd>
        </label>

        {selecaoAtiva ? (
          termo.trim() ? (
            <div className="painel-corpo">
              <BuscaSelecao termo={termo.trim()} aoEscolher={() => setTermo('')} />
            </div>
          ) : (
            <SelecaoAnalise />
          )
        ) : (
          <div className="painel-corpo" ref={corpo}>
            {termo.trim() ? (
              <Resultados termo={termo.trim()} aoEscolher={() => setTermo('')} />
            ) : rota.tela === 'imovel' ? (
              <>
                <div className="migalha">
                  <button className="nt-btn nt-btn--outline nt-btn--sm" onClick={voltar}><Icone.voltar /> Back</button>
                </div>
                <DetalheImovel key={rota.cod} id={rota.cod} />
              </>
            ) : (
              <Inicio />
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
