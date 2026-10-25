import { useMapa } from './mapa'
import { usePainel } from './painel'
import { navegar } from './rota'
import { useSelecao } from './selecao'

/** Ações que mexem em mais de uma parte do estado: ir a uma tela e deixar o painel e o mapa prontos para ela. */

export function abrirImovel(cod: string) {
  navegar({ tela: 'imovel', cod })
  usePainel.getState().abrir()
}

export function irParaInicio() {
  navegar({ tela: 'inicio' })
  usePainel.getState().abrir()
}

/** Abre a análise na lista de imóveis, com a camada do CAR, que é onde se clica; a lista fica guardada ao sair dela. */
export function abrirAnalise() {
  navegar({ tela: 'selecao' })
  usePainel.getState().abrir()
  useMapa.getState().ligarCamadas(['car'])
}

/** `substituir`: o relatório toma o lugar da tela atual no histórico (a escolha das análises, depois de emitir). */
export function abrirRelatorio(id: string, { substituir = false } = {}) {
  navegar({ tela: 'relatorio', id }, { substituir })
  usePainel.getState().abrir()
}

/** Começa a correção do relatório: a seleção vira a lista dele, com as análises dele marcadas, para ajustar e emitir. */
export function corrigirRelatorio(r: { id: string; imoveis: { cod_imovel: string }[]; analises: { id: string }[] }) {
  useSelecao.getState().corrigir(r.id, r.imoveis.map((i) => i.cod_imovel), r.analises.map((a) => a.id))
  navegar({ tela: 'selecao' })
  usePainel.getState().abrir()
}

export function novaSelecao() {
  useSelecao.getState().limpar()
  navegar({ tela: 'selecao' })
}
