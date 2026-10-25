import type { Status } from '../api/tipos'
import { STATUS } from '../formato'

/** Forma por status: o estado nunca depende só da cor. */
export function FormaStatus({ status, tamanho = 16 }: { status: Status; tamanho?: number }) {
  const cor = STATUS[status].cor
  // Contorno na cor da superfície do tema: separa a forma do fundo. Variável CSS só vale em `style`, não em atributo.
  const tinta = { stroke: 'var(--nt-surface)' }
  return (
    <svg width={tamanho} height={tamanho} viewBox="-12 -12 24 24" aria-hidden>
      {status === 'conforme' && <circle r="8" fill={cor} style={tinta} strokeWidth="2" />}
      {status === 'atencao' && <path d="M0 -9.5 L10 8 L-10 8 Z" fill={cor} style={tinta} strokeWidth="2" strokeLinejoin="round" />}
      {status === 'nao_conforme' && <path d="M0 -10 L10 0 L0 10 L-10 0 Z" fill={cor} style={tinta} strokeWidth="2" strokeLinejoin="round" />}
      {status === 'pendente' && (
        <>
          <circle r="7" fill="none" style={tinta} strokeWidth="6" />
          <circle r="7" fill="none" stroke={cor} strokeWidth="3" />
        </>
      )}
    </svg>
  )
}
