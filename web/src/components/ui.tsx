import { useCallback, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type FocusEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Status } from '../api/tipos'
import { STATUS } from '../formato'
import { usePainel } from '../store/painel'
import { FormaStatus } from './FormaStatus'
import { Icone } from './icones'

const LARGURA_BALAO = 300

/** Âncora de uma seção no DOM, a partir da chave: "Requer ação" → secao-requer-acao. */
export const idSecao = (chave: string) =>
  'secao-' + chave.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Abre a seção e rola o painel até ela. */
export function irParaSecao(chave: string) {
  usePainel.getState().abrirSecao(chave)
  requestAnimationFrame(() => document.getElementById(idSecao(chave))?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

/**
 * ⓘ ao lado de um título: o texto explicativo da seção num balão, ao passar o mouse, focar ou tocar.
 * O balão vai para o body, com posição fixa, para os painéis com rolagem própria não o cortarem.
 */
export function Info({ children }: { children: ReactNode }) {
  const id = useId()
  const botao = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)

  const abrir = () => {
    const r = botao.current!.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.left - 10, innerWidth - LARGURA_BALAO - 8))
    // Perto do pé da tela, abre para cima.
    setPos(r.bottom + 160 > innerHeight ? { left, bottom: innerHeight - r.top + 8 } : { left, top: r.bottom + 8 })
  }
  const fechar = () => setPos(null)

  useEffect(() => {
    if (!pos) return
    const tecla = (e: KeyboardEvent) => e.key === 'Escape' && fechar()
    addEventListener('keydown', tecla)
    addEventListener('scroll', fechar, true)
    addEventListener('resize', fechar)
    return () => {
      removeEventListener('keydown', tecla)
      removeEventListener('scroll', fechar, true)
      removeEventListener('resize', fechar)
    }
  }, [pos])

  return (
    <>
      <button
        ref={botao}
        type="button"
        className="info"
        aria-label="About this section"
        aria-describedby={pos ? id : undefined}
        onMouseEnter={abrir}
        onMouseLeave={fechar}
        onFocus={abrir}
        onBlur={fechar}
        onClick={abrir}
      >
        <Icone.info />
      </button>
      {pos && createPortal(<div id={id} role="tooltip" className="info-balao" style={{ ...pos, maxWidth: LARGURA_BALAO }}>{children}</div>, document.body)}
    </>
  )
}

export type LadoDica = 'direita' | 'esquerda' | 'cima' | 'baixo'

/**
 * Dica de um controle só com ícone: o nome dele num balão ao lado, ao passar o mouse (com uma pequena espera) ou ao
 * chegar pelo teclado. Vai para o body, com posição fixa, como o balão do `Info`. Devolve os eventos para o controle e
 * o balão para pôr junto dele.
 */
export function useDica<T extends HTMLElement>(texto: string, lado: LadoDica = 'cima') {
  const [pos, setPos] = useState<CSSProperties | null>(null)
  const espera = useRef(0)
  const fechar = useCallback(() => {
    clearTimeout(espera.current)
    setPos(null)
  }, [])
  const abrir = (el: T) => {
    const r = el.getBoundingClientRect()
    const meioX = r.left + r.width / 2
    const meioY = r.top + r.height / 2
    setPos({ direita: { left: r.right + 8, top: meioY }, esquerda: { left: r.left - 8, top: meioY }, cima: { left: meioX, top: r.top - 8 }, baixo: { left: meioX, top: r.bottom + 8 } }[lado])
  }

  useEffect(() => {
    if (!pos) return
    const tecla = (e: KeyboardEvent) => e.key === 'Escape' && fechar()
    addEventListener('keydown', tecla)
    addEventListener('scroll', fechar, true)
    addEventListener('resize', fechar)
    return () => {
      removeEventListener('keydown', tecla)
      removeEventListener('scroll', fechar, true)
      removeEventListener('resize', fechar)
    }
  }, [pos, fechar])
  useEffect(() => () => clearTimeout(espera.current), [])

  const eventos = {
    onMouseEnter: (e: MouseEvent<T>) => {
      const el = e.currentTarget
      clearTimeout(espera.current)
      espera.current = window.setTimeout(() => abrir(el), 250)
    },
    onMouseLeave: fechar,
    // Pelo teclado, na hora; o foco de um clique não abre (o clique já fecha).
    onFocus: (e: FocusEvent<T>) => e.currentTarget.matches(':focus-visible') && abrir(e.currentTarget),
    onBlur: fechar,
    onPointerDown: fechar,
  }
  const balao = pos && createPortal(<div role="tooltip" className={`dica dica--${lado}`} style={pos}>{texto}</div>, document.body)
  return [eventos, balao] as const
}

type PropsBotaoIcone = { rotulo: string; lado?: LadoDica; children: ReactNode } & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'title' | 'children' | 'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur' | 'onPointerDown'
>

/** Botão só com ícone: o `rotulo` é o nome dele para o leitor de tela e a dica que aparece ao lado. */
export function BotaoIcone({ rotulo, lado, children, ...resto }: PropsBotaoIcone) {
  const [dica, balao] = useDica<HTMLButtonElement>(rotulo, lado)
  return (
    <>
      <button type="button" aria-label={rotulo} {...resto} {...dica}>{children}</button>
      {balao}
    </>
  )
}

export function Badge({ status, rotulo }: { status: Status; rotulo?: string }) {
  return (
    <span className={`selo txt-${status}`}>
      <FormaStatus status={status} tamanho={13} />
      {rotulo ?? STATUS[status].rotulo}
    </span>
  )
}

interface SecaoProps {
  titulo: string
  /** Texto explicativo, num balão ao lado do título. */
  info?: ReactNode
  /** Contagem ou total ao lado do título, visível com a seção recolhida. */
  extra?: ReactNode
  /** Identifica a seção para abrir e rolar até ela (`irParaSecao`); por padrão, o título. */
  chave?: string
  /** Para resultados de uma ação (relatório, importação): começa aberta. */
  aberta?: boolean
  /** O conteúdo só existe com a seção aberta (o que ele consulta só é pedido quando alguém abre). */
  preguicosa?: boolean
  children: ReactNode
}

/**
 * Seção do painel, recolhida até o usuário abrir pelo título. O estado é por chave, então a mesma seção
 * continua aberta ao voltar para a tela. A âncora (`#secao-…`) permite chegar a ela a partir de um resumo.
 */
export function Secao({ titulo, info, extra, chave = titulo, aberta: inicial = false, preguicosa = false, children }: SecaoProps) {
  const alternada = usePainel((s) => s.secoesAbertas.has(chave))
  const alternar = usePainel((s) => s.alternarSecao)
  // Seções que começam abertas usam o conjunto ao contrário: estar nele é ter sido fechada.
  const aberta = alternada !== inicial
  const id = idSecao(chave)
  return (
    <section className={`secao${aberta ? ' secao--aberta' : ''}`} id={id}>
      <header>
        <h3>
          <button type="button" aria-expanded={aberta} aria-controls={`${id}-corpo`} onClick={() => alternar(chave)}>
            <Icone.seta />
            {titulo}
          </button>
          {info && <Info>{info}</Info>}
        </h3>
        {extra}
      </header>
      <div id={`${id}-corpo`} className="secao-corpo" hidden={!aberta}>{(aberta || !preguicosa) && children}</div>
    </section>
  )
}

/**
 * Um número do resumo, numa linha: rótulo à esquerda, valor à direita (com `colorir`, na cor do status). Com `ir`, leva ao lugar do app onde o número
 * aparece por inteiro: uma função (outra tela) ou a chave de uma seção da mesma tela.
 */
export function Indicador({ rotulo, valor, status, colorir, ir }: { rotulo: ReactNode; valor: ReactNode; status?: Status; colorir?: boolean; ir?: string | (() => void) }) {
  const conteudo = (
    <>
      {status && <FormaStatus status={status} tamanho={11} />}
      <span className="indicador-rot">{rotulo}</span>
      <b className={`nt-data${colorir && status ? ` txt-${status}` : ''}`}>{valor}</b>
      {ir && <Icone.seta />}
    </>
  )
  if (!ir) return <div className="indicador">{conteudo}</div>
  return (
    <button type="button" className="indicador" onClick={typeof ir === 'string' ? () => irParaSecao(ir) : ir}>
      {conteudo}
    </button>
  )
}

interface LinhaProps {
  status?: Status
  icone?: ReactNode
  titulo: ReactNode
  sub?: ReactNode
  direita?: ReactNode
  aoClicar?: () => void
}

/** Linha de lista: forma de status, título, subtítulo e valor à direita. Clicável, ganha a seta de quem leva a outra tela. */
export function Linha({ status, icone, titulo, sub, direita, aoClicar }: LinhaProps) {
  return (
    <button className="linha" onClick={aoClicar} disabled={!aoClicar}>
      <span className="linha-ic">{status ? <FormaStatus status={status} tamanho={15} /> : icone}</span>
      <span className="linha-tx">
        <strong>{titulo}</strong>
        {sub && <small>{sub}</small>}
      </span>
      {direita && <span className="linha-dir nt-data">{direita}</span>}
      {aoClicar && <span className="linha-seta"><Icone.seta /></span>}
    </button>
  )
}

/** Rótulo e valor. Com `aoClicar`, o valor leva a onde ele está detalhado (a instalação, o cliente, a remessa). */
export function Dado({ rotulo, children, aoClicar }: { rotulo: string; children: ReactNode; aoClicar?: () => void }) {
  return (
    <div className="dado">
      <span>{rotulo}</span>
      {aoClicar ? <button type="button" onClick={aoClicar}>{children}</button> : <b>{children}</b>}
    </div>
  )
}

/** Estado de carregamento ou erro de uma consulta, no lugar do conteúdo. */
export function Carregando({ erro }: { erro?: Error | null }) {
  return <p className="vazio">{erro ? `Couldn't load: ${erro.message}` : 'Loading…'}</p>
}
