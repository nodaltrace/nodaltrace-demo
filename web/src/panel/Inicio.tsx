import { useCamadasAmbientais, useSaude } from '../api/hooks'
import { Icone } from '../components/icones'
import { Carregando, Linha, Secao } from '../components/ui'
import { fmtDatasBase, fmtNum } from '../formato'
import { camera } from '../map/camera'
import { abrirAnalise, abrirImovel } from '../store/acoes'
import { useSelecao } from '../store/selecao'
import { RelatoriosEmitidos } from './analise/SelecaoAnalise'
import { EXEMPLOS } from './exemplos'

/** Abre o exemplo e leva o mapa até ele. */
function verExemplo(cod: string, limites: [number, number, number, number]) {
  abrirImovel(cod)
  camera.limites(limites)
}

/** Põe todos os exemplos na seleção (sem tirar os que já estavam) e abre a análise. */
function analisarExemplos() {
  const s = useSelecao.getState()
  for (const e of EXEMPLOS) if (!useSelecao.getState().imoveis.includes(e.cod)) s.alternar(e.cod)
  abrirAnalise()
}

/**
 * Tela inicial do painel: o que é o CAR, o recorte da demo, os imóveis de exemplo e quais bases reais estão carregadas
 * no banco (o CAR de cada UF e a camada do MapBiomas, com até quando vão os dados e quando foram carregados), com os
 * relatórios emitidos por último.
 */
export function Inicio() {
  const saude = useSaude()
  const camadas = useCamadasAmbientais()
  const cargas = saude.data?.cargas_car ?? []
  const mapbiomas = camadas.data?.find((c) => c.tipo === 'mapbiomas')

  return (
    <>
      <div className="titulo">
        <span className="etiqueta">Rural properties</span>
        <h2>Deforestation compliance for every property in the CAR</h2>
      </div>
      <div className="explica-car">
        <strong>What is the CAR?</strong>
        <p>
          The Cadastro Ambiental Rural (Rural Environmental Registry) is Brazil's mandatory public registry of rural
          properties. Owners declare each property's boundaries and its areas of native vegetation, and the government
          uses it to enforce the Forest Code. Every property gets a CAR code, like RS-4316907-09FE…
        </p>
      </div>
      <p className="nota">
        This demo uses real public data. It loads every MapBiomas deforestation alert in the state of Rio Grande do Sul.
        However, only around 25% of the state's CAR properties are loaded for the demo, in order to lower deployment cost.
      </p>

      <Secao titulo="Try these properties" aberta extra={<span className="nt-data">{EXEMPLOS.length}</span>}>
        {EXEMPLOS.map((e) => (
          <Linha key={e.cod} status={e.status} titulo={e.titulo} sub={e.sub} aoClicar={() => verExemplo(e.cod, e.limites)} />
        ))}
        <div className="acoes">
          <button className="nt-btn nt-btn--primary nt-btn--sm" onClick={analisarExemplos}>Analyze all {EXEMPLOS.length}</button>
        </div>
      </Secao>

      <Secao titulo="Loaded data" aberta extra={<span className="nt-data">{cargas.length} {cargas.length === 1 ? 'state' : 'states'}</span>}>
        {saude.error ? (
          <Carregando erro={saude.error} />
        ) : !saude.data ? (
          <Carregando />
        ) : (
          <>
            {cargas.length === 0 && <p className="nota">No CAR data loaded in the database.</p>}
            {cargas.map((c) => (
              <Linha key={c.uf} icone={<Icone.mapa />} titulo={`CAR · ${c.uf}`} sub={`SICAR · ${fmtDatasBase(c, 'updates')}`} />
            ))}
            {mapbiomas ? (
              <Linha
                icone={<Icone.alerta />}
                titulo={mapbiomas.nome}
                sub={`${fmtNum(mapbiomas.feicoes)} alerts · ${fmtDatasBase(mapbiomas, 'detections')}`}
              />
            ) : camadas.data && <p className="nota">MapBiomas Alerta not loaded in the database yet.</p>}
          </>
        )}
      </Secao>

      <RelatoriosEmitidos />
    </>
  )
}
