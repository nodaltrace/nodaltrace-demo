const base = { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export const Icone = {
  // Seções do trilho.
  inicio: () => (
    <svg {...base}><path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1v-8.5Z" /></svg>
  ),
  /** Prancheta com o visto: a seleção de imóveis e o relatório. */
  analise: () => (
    <svg {...base}><rect x="5" y="4.5" width="14" height="16.5" rx="2" /><path d="M9 4.5v-1h6v1M8.5 12.5l2.2 2.2 4.8-4.8" /></svg>
  ),
  voltar: () => (
    <svg {...base} width={16} height={16}><path d="M15 5l-7 7 7 7" /></svg>
  ),
  seta: () => (
    <svg {...base} width={12} height={12} strokeWidth={2.2}><path d="M9 6l6 6-6 6" /></svg>
  ),
  busca: () => (
    <svg {...base} width={15} height={15}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>
  ),
  temaClaro: () => (
    <svg {...base} width={17} height={17}><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></svg>
  ),
  temaEscuro: () => (
    <svg {...base} width={17} height={17}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>
  ),
  recolher: () => (
    <svg {...base} width={16} height={16}><path d="M4 5v14M19 12H9M13 8l-4 4 4 4" /></svg>
  ),
  alerta: () => (
    <svg {...base} width={16} height={16}><path d="M12 4l9.5 16h-19L12 4ZM12 10v4.5M12 17.5v.01" /></svg>
  ),
  /** Abre noutra aba (o explorer da Solana, a página de verificação). */
  externo: () => (
    <svg {...base} width={14} height={14} strokeWidth={2}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
  ),
  baixar: () => (
    <svg {...base} width={14} height={14} strokeWidth={2}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
  ),
  info: () => (
    <svg {...base} width={14} height={14} strokeWidth={2}><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.5v.01" /></svg>
  ),
  // Categorias dos controles do mapa.
  /** Perímetro de propriedade: polígono com vértices. */
  mapa: () => (
    <svg {...base}><path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20V6.5ZM9 4v13.5M15 6.5V20" /></svg>
  ),
  camadas: () => (
    <svg {...base}><path d="M12 4l9 4.5-9 4.5-9-4.5L12 4ZM3 12.5l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5" /></svg>
  ),
  ajustes: () => (
    <svg {...base}><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>
  ),
  regras: () => (
    <svg {...base}><path d="M10 6.5h10M10 12h10M10 17.5h10M3.5 6.5 5 8l2.5-2.5M3.5 12 5 13.5 7.5 11M3.5 17.5 5 19l2.5-2.5" /></svg>
  ),
  legenda: () => (
    <svg {...base}><circle cx="5.5" cy="6" r="2" /><rect x="3.5" y="10" width="4" height="4" rx=".5" /><path d="M5.5 16.5l2.2 3.8H3.3l2.2-3.8ZM11 6h9M11 12h9M11 18.5h9" /></svg>
  ),
}
