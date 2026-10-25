# attestor

Serviço interno que assina e envia ao Solana Attestation Service (devnet) o registro de cada relatório de análise:
a raiz Merkle do documento, a série, o número, o instante da emissão, a versão das regras e o número do relatório
substituído. Contrato: `docs/atestacao/CONTRATO.md` (§4, §5, §8).

## Chaves

Cofres em `chaves/<nome>.json` (fora do Git), scrypt + AES-256-GCM. Senha só pela env: `NT_CHAVES_SENHA_AUTORIDADE`
para `autoridade`, `NT_CHAVES_SENHA` para `atestador`.

```sh
npm run cli -- gerar <nome>                 # par novo; imprime só o endereço; arquivo 0600
npm run cli -- endereco <nome>              # endereço, sem senha
npm run cli -- importar <nome> <par.json>   # par do solana-cli (64 números)
npm run cli -- conferir <nome>              # decifra e sai com 0/1; não imprime segredo
node dist/cli.js revelar atestador | …      # segredo base58 (64 bytes) no stdout; recusa se o stdout for terminal
```

Duas chaves:

| chave | papel | onde é decifrada |
|---|---|---|
| `autoridade` | dona da credencial `NODALTRACE`: cria o schema, define o assinante autorizado e paga o setup | só no setup (senha própria) |
| `atestador` | assinante autorizado da credencial; paga a taxa e o aluguel de cada atestação | servidor |

O endereço da `autoridade` é a identidade pública do NodalTrace na rede: a credencial e o schema derivam dele. O servidor
recusa subir com `autoridade.json` em `NT_CHAVES_DIR` ou com `NT_CHAVES_SENHA_AUTORIDADE` na env.

Na nuvem não há cofre nem senha: `NT_CHAVE_ATESTADOR` traz o par já decifrado (base58, como o `revelar`), posto na env
pelo `deploy/kms-exec` a partir do texto cifrado pelo Cloud KMS. Com ela, o servidor ignora o cofre;
`NT_CHAVE_AUTORIDADE` é recusada como a senha da autoridade.

## Setup (credencial, schema e assinante)

```sh
NT_SOLANA_CLUSTER=devnet npm run setup               # plano + simulação; não envia; não pede senha
NT_CHAVES_SENHA_AUTORIDADE=… npm run setup -- --confirmar
# envia, assinado e pago pela `autoridade`. O atestador entra só como endereço: NT_ATESTADOR, ou o campo
# `endereco` de chaves/atestador.json.
```

Cria o que faltar (credencial `NODALTRACE`, schema `NT_RELATORIO` v1) e deixa o atestador como o **único** assinante
autorizado. Com um atestador novo, troca o assinante: é assim que se substitui uma chave vazada (os registros já feitos
continuam válidos; o atestador antigo deixa de conseguir atestar). Imprime `NT_AUTORIDADE=<endereço>` para o servidor.

## Fundos

```sh
NT_AUTORIDADE=… NT_ATESTADOR=… node dist/fundos.js saldos   # sai com 3 se alguma conta estiver abaixo do piso
node dist/fundos.js airdrop                                  # 1 SOL do faucet do RPC para cada conta abaixo do piso
```

Pisos: `NT_SALDO_MINIMO_LAMPORTS` (padrão 0,05 SOL) para o `atestador`, 0,02 SOL para a `autoridade`. Só lê endereços;
nunca envia transação nem decifra chave. Nunca na mainnet. É o que o `./run.sh solana` usa, no serviço descartável
`attestor-fundos`. Também dá para abastecer de uma carteira do solana-cli:
`solana transfer <endereço> 1 --url devnet --allow-unfunded-recipient`.

## Servidor

`node dist/servidor.js` (porta `PORT`, 8790). Rotas: `POST /atestar`, `GET /atestacao`, `GET /saude` (HMAC em
`X-NT-Tempo`/`X-NT-Assinatura`) e `GET /vivo` (sem autenticação, para healthcheck).

Ambiente: `NT_SOLANA_RPC` (devnet), `NT_SOLANA_CLUSTER` (`devnet` | `localnet`), `NT_ATTESTOR_SEGREDO` (≥ 32
caracteres), `NT_CHAVES_SENHA`, `NT_AUTORIDADE`, `NT_CHAVES_DIR`, `NT_SALDO_MINIMO_LAMPORTS` (piso do saldo do
`atestador`; padrão 50 000 000; abaixo dele `/atestar` responde `saldo`, 503).

Trava de rede: `devnet` exige RPC HTTPS com o genesis da devnet; `localnet` exige host local (ou em
`NT_LOCALNET_HOSTS`); mainnet só com `NT_PERMITIR_MAINNET=sim`.

## Testes

```sh
npm test                  # unidade
npm run test:integracao   # Surfpool embutido; clona o SAS da devnet (NT_SURFPOOL_REMOTO); pula sem rede
```
