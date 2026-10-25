/**
 * Leitura independente do registro de um relatório na Solana: direto do RPC, sem passar pela API do NodalTrace.
 * Carregado sob demanda (import dinâmico) pela página de verificação; é o único módulo que puxa @solana/kit.
 *
 * A conta é dado não confiável até prova em contrário (CONTRATO.md §4): endereço = PDA(credencial, schema, nonce da
 * série e do número), credencial e schema = PDAs derivadas da autoridade publicada, dono = programa SAS, discriminador
 * de atestação, dados no layout do schema sem sobra de bytes. O schema publicado na rede também é conferido.
 */
import { address, createSolanaRpc, fetchEncodedAccounts, getAddressDecoder, isAddress, type Address } from '@solana/kit'
import {
  findAttestationPda,
  findCredentialPda,
  findSchemaPda,
  getAttestationDataCodec,
  getAttestationDecoder,
  getCredentialDecoder,
  getSchemaDecoder,
  type Schema,
} from '@solana/attestation'
import { deHex } from './merkle'
import {
  DISCRIMINADOR_ATESTACAO,
  DISCRIMINADOR_SCHEMA,
  LAYOUT,
  NOME_CREDENCIAL,
  NOME_SCHEMA,
  PROGRAMA_SAS,
  VERSAO_SCHEMA,
  nonceDoRelatorio,
  normalizarCampos,
  type CamposRelatorio,
} from './relatorio'

export interface Checagem {
  rotulo: string
  ok: boolean
  detalhe?: string
}

export interface LeituraRede {
  checagens: Checagem[]
  /** Os campos gravados (só quando a conta passou nas checagens de estrutura). */
  campos: CamposRelatorio | null
  credencial: string
  schema: string
  /** A conta (PDA) do relatório. */
  conta: string
  /** Quem assinou o registro (o assinante autorizado da credencial na época). */
  assinante: string | null
  /** O assinante ainda é autorizado na credencial hoje (falso depois de uma troca de chave: os registros antigos valem). */
  assinanteAtual: boolean | null
  /** A transação que criou a conta, o slot e a hora do bloco. */
  transacao: string | null
  slot: number | null
  blocoEm: string | null
}

function schemaEsperado(credential: Address): Schema {
  return {
    discriminator: DISCRIMINADOR_SCHEMA,
    credential,
    name: NOME_SCHEMA,
    description: '',
    layout: LAYOUT.map(([, t]) => t),
    fieldNames: LAYOUT.map(([n]) => n),
    isPaused: false,
    version: VERSAO_SCHEMA,
  }
}

export async function lerRegistro(opcoes: { rpc: string; autoridade: string; serie: string; numero: number }): Promise<LeituraRede> {
  const checagens: Checagem[] = []
  const marcar = (rotulo: string, ok: boolean, detalhe?: string) => (checagens.push({ rotulo, ok, detalhe }), ok)
  const programa = address(PROGRAMA_SAS)
  if (!isAddress(opcoes.autoridade)) throw new Error('The published authority is not a valid address')

  const [credencial] = await findCredentialPda({ authority: address(opcoes.autoridade), name: NOME_CREDENCIAL }, { programAddress: programa })
  const [schema] = await findSchemaPda({ credential: credencial, name: NOME_SCHEMA, version: VERSAO_SCHEMA }, { programAddress: programa })
  const nonce = getAddressDecoder().decode(deHex(nonceDoRelatorio(opcoes.serie, opcoes.numero)))
  const [conta] = await findAttestationPda({ credential: credencial, schema, nonce }, { programAddress: programa })
  const leitura: LeituraRede = {
    checagens, campos: null, credencial, schema, conta, assinante: null, assinanteAtual: null, transacao: null, slot: null, blocoEm: null,
  }

  const rpc = createSolanaRpc(opcoes.rpc)
  // Uma chamada só (getMultipleAccounts), no mesmo slot: a atestação, o schema e a credencial.
  const [contaAtestacao, contaSchema, contaCredencial] = await fetchEncodedAccounts(rpc, [conta, schema, credencial], { commitment: 'confirmed' })

  // O schema publicado tem o layout do contrato (senão a leitura dos dados abaixo não vale).
  if (marcar('NT_RELATORIO schema published by the credential', contaSchema.exists && contaSchema.programAddress === programa, schema) && contaSchema.exists) {
    try {
      const [s, fim] = getSchemaDecoder().read(contaSchema.data, 0)
      const e = schemaEsperado(credencial)
      marcar(
        'Schema has the contract layout',
        fim === contaSchema.data.length && s.discriminator === DISCRIMINADOR_SCHEMA && s.credential === credencial && s.name === NOME_SCHEMA &&
          s.version === VERSAO_SCHEMA && JSON.stringify(s.layout) === JSON.stringify(e.layout) && JSON.stringify(s.fieldNames) === JSON.stringify(e.fieldNames),
        `${NOME_SCHEMA} v${s.version}`,
      )
    } catch (err) {
      marcar('Schema has the contract layout', false, (err as Error).message)
    }
  }
  let autorizados: string[] = []
  if (contaCredencial.exists && contaCredencial.programAddress === programa) {
    try {
      const c = getCredentialDecoder().decode(contaCredencial.data)
      marcar('NODALTRACE credential of the published authority', c.authority === opcoes.autoridade, c.authority)
      autorizados = c.authorizedSigners
    } catch (err) {
      marcar('NODALTRACE credential of the published authority', false, (err as Error).message)
    }
  } else {
    marcar('NODALTRACE credential of the published authority', false, 'the credential account does not exist')
  }

  if (!marcar('Report account exists on-chain', contaAtestacao.exists, conta) || !contaAtestacao.exists) return leitura
  if (!marcar('Owner = SAS program', contaAtestacao.programAddress === programa, contaAtestacao.programAddress)) return leitura
  let a
  try {
    const [lida, fim] = getAttestationDecoder().read(contaAtestacao.data, 0)
    if (fim !== contaAtestacao.data.length) throw new Error(`${contaAtestacao.data.length - fim} extra bytes in the account`)
    a = lida
  } catch (err) {
    marcar('Account decodes as an attestation', false, (err as Error).message)
    return leitura
  }
  if (!marcar('Discriminator = attestation', a.discriminator === DISCRIMINADOR_ATESTACAO, String(a.discriminator))) return leitura
  marcar('Account credential and schema = the expected ones', a.credential === credencial && a.schema === schema)
  marcar('Nonce = report series and number', a.nonce === nonce)
  marcar('Permanent registration (no expiry)', a.expiry === 0n, String(a.expiry))
  leitura.assinante = a.signer
  leitura.assinanteAtual = autorizados.includes(a.signer)
  try {
    const [cru, fim] = getAttestationDataCodec(schemaEsperado(credencial)).read(a.data, 0)
    if (fim !== a.data.length) throw new Error(`${a.data.length - fim} extra bytes in the data`)
    leitura.campos = normalizarCampos(cru as Record<string, unknown>)
    marcar('Data in the schema layout', true)
  } catch (err) {
    marcar('Data in the schema layout', false, (err as Error).message)
  }

  // A transação que criou a conta: a mais antiga do endereço (a lista vem da mais nova para a mais antiga).
  try {
    const assinaturas = await rpc.getSignaturesForAddress(conta, { commitment: 'confirmed' }).send()
    const primeira = assinaturas.at(-1)
    if (primeira) {
      leitura.transacao = primeira.signature
      leitura.slot = Number(primeira.slot)
      leitura.blocoEm = primeira.blockTime !== null && primeira.blockTime !== undefined ? new Date(Number(primeira.blockTime) * 1000).toISOString() : null
    }
  } catch {
    // O RPC público pode não guardar o histórico: a conta já basta para conferir o conteúdo.
  }
  return leitura
}
