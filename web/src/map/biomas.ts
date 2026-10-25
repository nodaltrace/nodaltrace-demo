/**
 * Biomas do IBGE (Biomas e Sistema Costeiro-Marinho do Brasil, 1:250.000). Tons apagados derivados das cores
 * oficiais do IBGE (Bioma_n1_2025.qml), mesma ordem de matiz: entram como um véu translúcido nos dois temas.
 * `nome` é o dado dos tiles (`nome` em ref.bioma, em português) e não muda; `rotulo` é o que a legenda mostra.
 */
const TABELA: { nome: string; rotulo: string; cor: string }[] = [
  { nome: 'Amazônia', rotulo: 'Amazon', cor: '#7E9A6E' },
  { nome: 'Caatinga', rotulo: 'Caatinga', cor: '#BDB58A' },
  { nome: 'Cerrado', rotulo: 'Cerrado', cor: '#B89A86' },
  { nome: 'Mata Atlântica', rotulo: 'Atlantic Forest', cor: '#93A88A' },
  { nome: 'Pampa', rotulo: 'Pampa', cor: '#B7AE9C' },
  { nome: 'Pantanal', rotulo: 'Pantanal', cor: '#A497A8' },
]

/** A legenda: [rótulo, cor] de cada bioma. */
export const BIOMAS: [string, string][] = TABELA.map((b) => [b.rotulo, b.cor])

export const COR_BIOMA = ['match', ['get', 'nome'], ...TABELA.flatMap((b) => [b.nome, b.cor]), '#8A939D'] as const
