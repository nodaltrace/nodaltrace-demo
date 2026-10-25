# Registro dos relatórios na Solana: contrato entre as partes

Fonte única para a API (Python), o serviço `attestor/` (TypeScript), o frontend e o verificador independente
(`verificar.py`). Mudou aqui, muda em todos; os vetores (`vetores.json`) amarram as implementações. Rede: **devnet** (a
rede é configuração; a mainnet fica travada até uma decisão).

## 0. Regras que não se negociam

- **Todo relatório é registrado, automaticamente.** A emissão grava o relatório e o registro pendente na mesma
  transação; um trabalhador da API manda os pendentes à rede logo depois. Não existe botão: registrar só alguns deixaria
  escolher quais.
- **Um relatório emitido não muda nem sai.** Um erro se corrige com outro relatório, que diz qual substitui e por quê,
  registrado do mesmo jeito (§2.4). O banco recusa UPDATE, DELETE e TRUNCATE no relatório (§7).
- **Quem confere é o terceiro, pelo conteúdo.** A prova é: o hash que a pessoa calcula do arquivo que tem é o que está
  na rede, gravado pela credencial do NodalTrace. A coluna da raiz no banco é só um índice.
- **Nada privado na rede.** Na rede vão a raiz, a série, o número, o instante da emissão, a versão das regras e o número
  do relatório substituído. Nenhum código do CAR, cliente ou resultado.
- **Chaves fora da API.** Só o `attestor` tem a chave do atestador; a da autoridade fica fora de qualquer serviço que
  fique no ar (§8). A API conversa com o `attestor` por HMAC (§5).
- **Devnet não é prova durável.** Ela demonstra o mecanismo; não garante guardar o histórico. Tudo o que é mostrado diz
  a rede.

## 1. Conceitos

- **Série**: um UUID por banco (`app.serie`), criado pela migração 031 (e de novo pelo `pipeline limpar`). Os números
  dos relatórios são sequenciais dentro dela, sem lacuna. Um banco novo ou restaurado é outra série: nunca reaproveita um
  número já registrado.
- **Relatório**: `NT-AAAA-NNNNNN` (ano da emissão + número na série). Guarda o documento (§2) e a raiz (§3).
- **Registro** (`app.ancoragem`): a conta do relatório no Solana Attestation Service, com a transação que a criou.
- **Autoridade**: o endereço da chave dona da credencial `NODALTRACE`. É a identidade pública do NodalTrace na rede: a
  credencial, o schema e a conta de cada relatório derivam dele (§4). Publicado no README, nos PDFs, na página de
  verificação e no `/saude`.

## 2. Documento (`NT_RELATORIO/1`)

O documento é a lista das folhas da árvore de Merkle, guardado e baixado como `{"itens": [...]}` em JCS (RFC 8785),
na ordem: `cabecalho`, `resumo` e um `imovel` por código, na ordem do pedido (a árvore ordena as folhas sozinha). Cada
item tem `tipo` e `id`, únicos juntos.

Regras de valor: datas `"AAAA-MM-DD"`; instantes RFC 3339 UTC com `Z`, precisão de segundo; ausente = `null` (a chave
sempre existe); texto em NFC; hashes em hex minúsculo; números como números JSON (o JCS define a escrita deles).

### 2.1 `cabecalho` (id `"cabecalho"`)

| campo | conteúdo |
|---|---|
| `formato` | `"NT_RELATORIO/1"` |
| `relatorio`, `serie`, `numero` | id, UUID da série, número |
| `emitido_em` | instante da emissão |
| `emissor` | `null` até existirem contas de usuário |
| `regras` | `{versao, parametros}`: `VERSAO_REGRAS` e os parâmetros em vigor (§10) |
| `bases` | `[{fonte, nome, uf, versao, dados_ate, publicado_em, carregado_em}]`: as bases usadas, com as datas dos dados |
| `analises` | `[{id, nome, descricao, base}]`, na ordem do catálogo |
| `substitui` | `null` ou `{relatorio, numero, motivo}` (§2.4) |

### 2.2 `resumo` (id `"resumo"`)

`sal`, `status` (o pior entre os imóveis), `contagem` (`{conforme, pendente, atencao, nao_conforme}`), `imoveis`
(quantos). Fica fora do cabeçalho para que a prova de um imóvel não revele o resultado da carteira inteira.

### 2.3 `imovel` (id = código do CAR)

`sal`, `uf`, `municipio`, `area_ha`, `mod_fiscal`, `situacao`, `vigente`, `versao_car` (`{valido_de, hash}`: a versão do
CAR analisada, com o hash da linha), `limites`, `status` (o pior entre as análises que emitem veredito) e `resultados`:
`[{analise, status, resumo, detalhes, fatos}]`.

`fatos` é a evidência em dados, para quem audita conferir na fonte:

| análise | `fatos` |
|---|---|
| `situacao_car` | `{situacao, condicao, vigente, atualizado_sicar}` |
| `desmatamento_eudr` | `{alertas: [{alerta, detectado_em, area_ha, area_alerta_ha, classe, fontes, pos_corte}]}`: `alerta` é o id no MapBiomas Alerta |
| `bioma` | `{biomas: [{bioma, area_ha, fracao}]}` |
| `embargo` | `{n, area_ha}` |
| `renovabio_rb01` | `{corte, alertas: [...], sinais: [...]}`: os alertas depois do corte do RenovaBio e os sinais X-01/X-02 |
| `renovabio_rb02` | `{situacao, vigente}` |

**Sal**: 32 bytes aleatórios em hex, diferentes em cada `imovel` e no `resumo`. Sem ele, quem tem os hashes vizinhos de
uma prova parcial poderia adivinhar um imóvel escondido a partir dos dados públicos do SICAR.

### 2.4 Correção

`POST /relatorios` com `substitui` (id) e `motivo` (10 a 500 caracteres) emite um relatório novo, com as análises
rodadas de novo (dados e regras de hoje; a lista de imóveis pode mudar). O cabeçalho leva `substitui` e a rede leva o
número em `replaces`. Cada relatório é substituído no máximo uma vez: a correção de uma correção substitui a mais nova.
O substituído não muda; o "substituído por" é calculado (o relatório cujo `substitui` é ele).

## 3. Árvore de Merkle e provas

- Ordem das folhas: itens ordenados por (`tipo`, `id`), comparando os bytes UTF-8.
- Folha: `sha256(0x00 ‖ JCS(item))`. Nó: `sha256(0x01 ‖ esquerda ‖ direita)`.
- Em cada nível, pares (0,1), (2,3)…; um nó ímpar no fim **sobe sem hash**. Lista vazia: erro.
- Prova de inclusão de uma folha: os irmãos até a raiz, cada um `{lado: "esquerda" | "direita", hash}`; o nó ímpar que
  sobe sem hash não gera passo.

**Prova parcial** (`POST /relatorios/{id}/prova`, `{imoveis: [...], resumo: bool}`): revela o cabeçalho (sempre), os
imóveis pedidos e, se pedido, o resumo, cada um com a prova até a raiz:

```json
{"formato": "NT_RELATORIO_PROVA/1", "relatorio": "NT-2026-000001", "raiz": "<hex>",
 "itens": [<cabecalho>, <imovel>],
 "provas": {"cabecalho:cabecalho": [{"lado": "direita", "hash": "<hex>"}], "imovel:<cod>": [...]}}
```

Quem recebe sobe de cada folha até a raiz: todas têm de chegar à mesma, e ela tem de ser a da rede.

`vetores.json`: `casos` traz árvores com a ordem, o JCS de cada item, as folhas e a raiz; `relatorio`, um documento
completo com as folhas, a raiz, a prova de cada folha, o nonce, os campos do §4, os bytes deles no SAS e as PDAs para uma
autoridade de teste. Python (API e `verificar.py`) e TypeScript (attestor e frontend) os reproduzem byte a byte.

## 4. Na rede: Solana Attestation Service (SAS)

- Programa SAS: `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG` (mesmo id em devnet e mainnet). Cliente TypeScript:
  `@solana/attestation` 2.1.0 sobre `@solana/kit` 8.
- Credencial `NODALTRACE`, da chave `autoridade`; assinante autorizado único: a chave `atestador`.
- Identidade publicada na devnet: autoridade `2B1bKsw9hg7BMF5BrUAEzeABB2a38ESKoNvzSUHaF5VF` → credencial `4Vz1LpLi79ufM6McFm8Hv1JmsgyDXAe9RR1Cy1x8w83G`, schema
  `FNM5eBAVgo6Fn6B8eFirWr6CkwvWF2bZn6A9qWPcdLCL`.
- Schema `NT_RELATORIO`, versão 1. Códigos de tipo do SAS: U32 = 2, I64 = 8, String = 12, VecU8 = 13.

| campo | tipo | valor |
|---|---|---|
| `root` | VecU8 (32) | raiz de Merkle do documento |
| `series` | String | UUID da série (36 caracteres, minúsculo) |
| `number` | U32 | número na série (≥ 1) |
| `issued_at` | I64 | `emitido_em` em segundos Unix |
| `ruleset` | String | `VERSAO_REGRAS` (1 a 32 caracteres: letras, dígitos, `.`, `_`, `-`) |
| `replaces` | U32 | número do relatório substituído, na mesma série; `0` = nenhum; sempre menor que `number` |

- **Nonce** = `sha256(utf8("NT_RELATORIO:" + serie + ":" + numero))` (número em decimal, sem zeros à esquerda), lido como
  endereço. PDAs (sementes do cliente oficial): credencial = `["credential", autoridade, "NODALTRACE"]`; schema =
  `["schema", credencial, "NT_RELATORIO", u8 1]`; conta do relatório = `["attestation", credencial, schema, nonce]`.
- Uma conta só por (série, número): outro documento com o mesmo número não cabe (`conflito`); reenviar o mesmo cai na
  mesma conta (`ja_existe`), o que torna o reenvio seguro.
- `expiry` = 0. A conta nunca é fechada: fechá-la apagaria a prova.
- Transação v0, simulada antes de enviar. O `atestador` paga a taxa e o aluguel (`payer`) e assina como `authority`.
  Custo medido na devnet: 0,00205224 SOL por relatório (aluguel de 0,00204724 SOL da conta de 275 bytes, mais a taxa de
  0,000005 SOL).

Conferência de uma conta (attestor, frontend, `verificar.py`): o endereço é a PDA acima; a conta existe, dono = SAS,
discriminador = 2 (Attestation: `u8 discriminador, nonce, credencial, schema, vec<u8> dados, assinante, i64 expiry,
token`), credencial, schema e nonce = os esperados, sem bytes sobrando; os dados decodificam pelo layout sem sobra; e os
campos batem com os do documento.

## 5. Serviço `attestor` (HTTP interno)

Autenticação de toda requisição: cabeçalhos `X-NT-Tempo` (segundos Unix) e `X-NT-Assinatura` =
hex(HMAC-SHA256(`NT_ATTESTOR_SEGREDO`, `tempo + "\n" + MÉTODO + "\n" + caminho_com_query + "\n" + corpo`)). Janela de
60 s; comparação em tempo constante. Sem assinatura válida: 401. O segredo existe só nos ambientes `api` e `attestor` e
muda a cada `./run.sh solana-up`.

| método e caminho | corpo / parâmetros | resposta 200 |
|---|---|---|
| `POST /atestar` | `{"schema": "NT_RELATORIO", "nonce": hex64, "campos": {root, series, number, issued_at, ruleset, replaces}}` (`root` em hex) | `{"pda", "assinatura", "slot", "bloco_em", "cluster"}` |
| `GET /atestacao?schema=NT_RELATORIO&nonce=…` | | `{"existe": false}` ou `{"existe": true, "pda", "campos", "assinatura", "slot", "bloco_em"}` (validado como no §4; a transação é a mais antiga da conta) |
| `GET /saude` | | `{"cluster", "rpc", "programa", "autoridade", "credencial", "schema", "existem": {"credencial", "NT_RELATORIO"}, "atestador", "assinante_autorizado", "saldo", "saldo_minimo"}` |
| `GET /vivo` | sem HMAC | `{"ok": true}` (healthcheck) |

O attestor recalcula o nonce dos campos e recusa um pedido em que não batam. Erros: corpo `{"erro": "<codigo>",
"detalhe": "..."}` com código em `entrada` (400), `simulacao` (422, com `logs`), `rpc` (502), `saldo` (503: o saldo do
`atestador` está abaixo de `NT_SALDO_MINIMO_LAMPORTS`, padrão 50 000 000; nada é enviado), `ja_existe` (409, a conta já
existe **com os mesmos dados**; a PDA vai no corpo) e `conflito` (409, existe com dados diferentes).

## 6. API (FastAPI)

| método e caminho | resposta |
|---|---|
| `POST /relatorios` | 201, o relatório com `ancoragem.status = pendente`. Corpo `{imoveis, analises, substitui?, motivo?}` |
| `GET /relatorios` | os mais recentes, com o estado do registro, `substitui` e `substituido_por` |
| `GET /relatorios/{id}` | o relatório para ler (as folhas remontadas, sem os sais), `raiz`, `integro` (a raiz recalculada das folhas guardadas = a registrada), `substituido_por` e `ancoragem` |
| `GET /relatorios/{id}/documento` | o documento guardado, byte a byte (download `.json`) |
| `POST /relatorios/{id}/prova` | a prova parcial (§3) |
| `GET /relatorios/{id}/pdf` | o PDF, com a seção "Registro na Solana" e o QR code de `<NT_URL_PUBLICA>/verificar/<id>` |
| `GET /verificacao/{id}` | **pública**: `relatorio`, `serie`, `numero`, `emitido_em`, `regras`, `raiz`, `substitui`, `substituido_por`, `registro` (sem o texto dos erros) e `rede` (`cluster`, `rpc`, `programa`, `autoridade`, `credencial`, `schema`). Nada dos imóveis nem dos resultados |
| `GET /saude` | + `ancoragem`: `ligada`, `serie`, `pendentes`, `falhas`, `rede` |

Envio (`servicos/ancoragem.py`): um trabalhador numa thread da API, com uma trava consultiva no banco (um só por banco),
pega o pendente mais antigo por número cuja vez chegou, marca `enviando`, chama `POST /atestar` fora de transação
(espera 200 s; o attestor corta em 180 s) e:

- 200 → `confirmada`, com conta, transação, slot e hora do bloco (se o RPC ainda não a tinha, relê a conta);
- `ja_existe` → lê a conta (`GET /atestacao`) e, com os mesmos campos, `confirmada`;
- `conflito`, `entrada` → `falhou` (revisão humana);
- qualquer outro erro (`rpc`, `saldo`, `simulacao`, `indisponivel`, `autenticacao`) → `pendente` de novo, com o erro e a
  próxima tentativa em 30 s · 2ⁿ⁻¹ (até 1 h).

Na subida, o que ficou `enviando` volta a `pendente` e é reenviado (o reenvio é idempotente, §4). O trabalhador só sobe
com o attestor configurado (`NT_ATTESTOR_URL` e `NT_ATTESTOR_SEGREDO`) e nunca num banco `*_teste`.

## 7. Banco (`db/031_relatorio_ancorado.sql`)

- `app.serie` (uma linha): `id` (UUID), `criada_em`, `ultimo`. A emissão tira o número com `UPDATE … SET ultimo =
  ultimo + 1` na própria transação, depois de rodar as análises: uma emissão desfeita devolve o número.
- `app.relatorio`: `id`, `serie`, `numero` (`UNIQUE (serie, numero)`), `emitido_em`, `imoveis`, `analises`, `status`,
  `regras`, `substitui` (`UNIQUE`, referência ao relatório corrigido), `motivo`, `documento` (o JCS das folhas), `raiz`
  (`UNIQUE`). Só INSERT: os gatilhos recusam UPDATE, DELETE e TRUNCATE.
- `app.ancoragem`: `relatorio`, `status` (`pendente | enviando | confirmada | falhou`), `tentativas`,
  `proxima_tentativa`, `erro`, `cluster`, `conta`, `transacao`, `slot`, `bloco_em`, `enviada_em`, `confirmada_em`. Muda
  até confirmar; depois, os gatilhos recusam UPDATE; DELETE e TRUNCATE nunca.
- `nodaltrace.apagar_relatorios = 'sim'` na sessão libera os gatilhos: só o `pipeline limpar` a usa, e ele começa uma
  série nova. É proteção contra acidente: para terceiros, a prova é a rede.

Restaurar um backup mais antigo que o último relatório registrado reaproveitaria números já registrados: o registro dá
`conflito`. Nesse caso, comece uma série nova (`INSERT` de uma nova linha em `app.serie`, depois de apagar a antiga).

## 8. Chaves e segredos

| chave | papel | senha (env) | onde é decifrada |
|---|---|---|---|
| `autoridade` | dona da credencial: cria o schema, define o assinante autorizado, paga o setup | `NT_CHAVES_SENHA_AUTORIDADE` (própria) | só no setup (serviço descartável `attestor-setup`) |
| `atestador` | assinante autorizado; paga a taxa e o aluguel de cada registro | `NT_CHAVES_SENHA` | servidor `attestor` |

Repouso: um cofre por chave em `attestor/chaves/<nome>.json` (fora do Git) = `{"versao": 1, "kdf": "scrypt", "n", "r",
"p", "sal", "iv", "tag", "cifra", "endereco"}`, scrypt + AES-256-GCM (`node:crypto`), com o endereço como AAD. As senhas
são pedidas sem eco pelo `run.sh` e nunca gravadas em disco. Na nuvem, `NT_CHAVE_ATESTADOR` chega decifrada pelo Cloud
KMS (`deploy/kms-exec`); a chave e a senha da autoridade nunca vão para a nuvem.

Isolamento: o servidor monta só `atestador.json` e recusa subir se o cofre ou a senha da autoridade aparecerem; o setup
monta só `autoridade.json`; os fundos não montam cofre.

**Troca de chave** (atestador vazado): gere outra chave, rode o setup (ele deixa o novo atestador como o único assinante
autorizado) e publique a data. Os registros feitos antes continuam válidos; o atestador antigo deixa de conseguir
registrar. A credencial, e portanto a identidade publicada, não muda.

## 9. Verificação independente

Com o documento (ou uma prova parcial) e o endereço da autoridade publicado pelo NodalTrace, qualquer pessoa confere:

1. Recalcular a raiz das folhas pelo §3 (na prova parcial, subir de cada folha pelos irmãos).
2. Tirar do cabeçalho a série e o número; calcular o nonce e as PDAs do §4.
3. Ler a conta do relatório num RPC qualquer da rede e conferi-la pelo §4.
4. Comparar `root`, `series`, `number`, `issued_at`, `ruleset` e `replaces` com os do documento.
5. Opcional: a transação mais antiga da conta dá o bloco (e a hora) do registro. A rede garante que o documento existia
   naquele bloco; antes dele, vale a data de emissão que o NodalTrace declara (`issued_at`). Com mais de 10 minutos entre
   as duas (registro tardio, ou o relógio do servidor adiantado), as duas implementações avisam, sem deixar de conferir.

Duas implementações seguem esta receita: a página `/verificar` (no navegador, lendo o RPC direto, com a autoridade
fixada no build em `VITE_NT_AUTORIDADE`) e `verificar.py` (Python, só `rfc8785` além da biblioteca padrão).

## 10. Versão das regras

`VERSAO_REGRAS` (`api/nodaltrace/dominio/conformidade.py`) identifica as regras de decisão: as de
`dominio/conformidade.py`, as do RenovaBio (`dominio/renovabio.py` e `regras/renovabio.yaml`) e a lógica das análises
de `servicos/catalogo.py`. Vai no cabeçalho de cada relatório (com os parâmetros) e na rede (`ruleset`).

`api/nodaltrace/regras/versoes.json` registra cada versão: `versao`, `desde`, `hash_parametros` (SHA-256 do JCS dos
parâmetros) e `mudou`. Um teste falha se os parâmetros de hoje não forem os da versão em vigor. Mudou um parâmetro ou a
lógica de uma decisão: acrescente uma versão (as antigas ficam: é por elas que se lê um relatório antigo) e suba
`VERSAO_REGRAS`.
