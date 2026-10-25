#!/usr/bin/env bash
# Sobe e prepara o ambiente completo do NodalTrace (ver README.pt-BR.md, "Como rodar").
#
# Uso: ./run.sh [comando]     Linux, macOS ou Windows pelo WSL 2 (o mesmo script nos três; ver README.pt-BR.md)
#
#   all      (padrão; serve também para a primeira vez) diagnóstico + infra + migrações + ingestão externa + resumo
#            das bases carregadas + oferta de ligar a atestação na Solana (se estiver desligada) + frontend
#   diagnostico  confere a máquina sem mudar nada: Docker, memória, Node, portas, disco, bases e o que está carregado
#   infra    cria o .env, sobe PostGIS, Martin e API e espera o banco ficar saudável
#   migrar   aplica as migrações de db/
#   dados    roda as cargas do pipeline: CAR de todos os estados em dados/AREA_IMOVEL/<UF>/, em paralelo (pula o que não tem arquivo)
#   web      instala as dependências e inicia o frontend (http://localhost:5173)
#   test     paridade entre pacotes; testes da pipeline e da API sobre o banco nodaltrace_teste, recriado com a
#            amostra de dados reais de tests/dados/ (tests/preparar_banco_teste.sh)
#   tipos    regera web/src/api/contrato.ts (os tipos das respostas da API para o frontend) depois de mudar um modelo em
#            api/nodaltrace/modelos/; a CI falha se o arquivo não estiver em dia
#   psql     abre o psql no banco
#   deps     regera as travas das dependências Python (api/requirements*.txt e pipeline/requirements.txt, com hash) depois
#            de mudar api/pyproject.toml ou pipeline/requirements.in; mantém as versões travadas que ainda cabem nas
#            faixas (./run.sh deps --atualizar sobe tudo até o limite das faixas)
#   status   mostra os containers
#   logs     acompanha os logs
#   down     para os containers (mantém os dados)
#   limpar   volta ao banco recém-migrado: apaga CAR, municípios, MapBiomas, biomas e os relatórios emitidos, que
#            recomeçam numa série nova (mantém containers, migrações e os arquivos de dados/; --sim pula a confirmação)
#   reset    para os containers E APAGA o banco (volume pgdata)
#
# Atestação na Solana (devnet; ver README.pt-BR.md, "Atestação na Solana (devnet)"):
#   solana         tudo de uma vez, perguntando: contas novas (com airdrop de 1 SOL da devnet) ou as que você já tem
#                  (arquivos do solana-cli); saldos; setup do SAS; solana-up; saúde. Pede "s" antes de cada envio na
#                  devnet e pula o que já está feito
# Os mesmos passos, um a um, nesta ordem:
#   solana-chaves  gera os cofres que faltam em attestor/chaves/ (autoridade e atestador; pede a senha do atestador e,
#                  para a autoridade, uma senha própria) e mostra os endereços e o que abastecer; nunca pede airdrop
#                  sozinho
#   solana-setup   mostra o plano de criação da credencial e do schema NT_RELATORIO no SAS, sem enviar nada
#                  (./run.sh solana-setup --confirmar pede a senha da autoridade e envia, depois de revisado)
#   solana-up      pede a senha do atestador, sobe o attestor com um segredo novo e recria só a API para recebê-lo
#   solana-saude   consulta o /saude do attestor (rede, credencial, schema, assinante autorizado, saldo)
#   solana-down    para e remove o attestor (a senha sai da env do container)
#
# Variáveis opcionais (defina no ambiente, ex.: UFS="RS SC" ./run.sh dados):
#   UFS="RS SC"                estados do CAR a carregar (padrão: toda pasta em dados/AREA_IMOVEL/<UF>/)
#   PARALELO=4                 estados do CAR carregados ao mesmo tempo
#   CAR_PUBLICADO_EM=AAAA-MM-DD       data de publicação (ou de download) dos arquivos do CAR no SICAR; sem ela, cada
#                                     carga vale pela atualização mais recente de um imóvel no arquivo
#   MAPBIOMAS_PUBLICADO_EM=AAAA-MM-DD idem, do arquivo do MapBiomas; sem ela, vale a detecção mais recente do arquivo
#   ALERTAS_ARQUIVO=...        shapefile de alertas do MapBiomas (em /dados)
#   BIOMAS_ARQUIVO=...         shapefile dos biomas do IBGE (em /dados)
#   NT_SOLANA_RPC=https://...  RPC da devnet (padrão https://api.devnet.solana.com)
#   NT_SALDO_MINIMO_LAMPORTS=… piso de saldo do `atestador` para atestar (padrão 50000000 = 0,05 SOL)
#
# Pasta no container: /dados = DADOS_DIR do .env (padrão ./dados; ver dados/README.md).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# ---------- utilitários ----------
log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[aviso]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[erro]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- plataforma ----------
# Este script roda no bash 3.2 do macOS: nada de arrays associativos, mapfile nem ${x,,}, e array vazio só com
# ${a[@]+"${a[@]}"} (com set -u, "${a[@]}" vazio é erro no 3.2). Só ferramentas POSIX, sem opções exclusivas do GNU.
SO=$(uname -s)
eh_wsl() { [[ "$SO" == Linux ]] && grep -qi microsoft /proc/version 2>/dev/null; }

case "$SO" in
  MINGW*|MSYS*|CYGWIN*)
    die "No Windows, rode pelo WSL 2: no terminal do Ubuntu, clone o repositório dentro do WSL (ex.: ~/nodaltrace-app) e rode ./run.sh de lá (ver README.pt-BR.md, \"Windows\")." ;;
esac
if eh_wsl && [[ "$PWD" == /mnt/[a-z]/* ]]; then
  warn "O repositório está no disco do Windows ($PWD): fica lento no Docker e a API e o frontend não recarregam sozinhos. Clone dentro do WSL (ex.: ~/nodaltrace-app)."
fi

dica_docker() {
  if [[ "$SO" == Darwin ]]; then
    echo "Instale e abra o Docker Desktop: https://docs.docker.com/desktop/setup/install/mac-install/"
  elif eh_wsl; then
    echo "Abra o Docker Desktop no Windows e ative Settings → Resources → WSL integration para esta distro."
  else
    echo "Instale o Docker Engine com o plugin compose (https://docs.docker.com/engine/install/) e inicie-o: sudo systemctl start docker"
  fi
}

# O CLI responde sem o daemon; sem ele, o compose falha com um erro de socket pouco claro.
exigir_docker() {
  command -v docker >/dev/null || die "Docker não encontrado. $(dica_docker)"
  docker compose version >/dev/null 2>&1 || die "Plugin 'docker compose' (v2) não encontrado. $(dica_docker)"
  local erro
  erro=$(docker info 2>&1 >/dev/null) && return 0
  [[ "$erro" == *"ermission denied"* ]] \
    && die "Sem permissão para usar o Docker. Rode: sudo usermod -aG docker \"\$USER\", saia da sessão e entre de novo."
  if [[ "$SO" == Darwin ]] && open -a Docker 2>/dev/null; then
    log "Iniciando o Docker Desktop"
    for _ in $(seq 60); do docker info >/dev/null 2>&1 && return 0; sleep 2; done
  fi
  docker info >/dev/null 2>&1 || die "O Docker não está rodando. $(dica_docker)"
}

# O Vite 8 pede ^20.19.0 || >=22.12.0; abaixo disso ele falha com um erro pouco claro. O attestor pede 22.12+.
node_ok() {
  command -v node >/dev/null && command -v npm >/dev/null \
    && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) || (a === 20 && b >= 19) ? 0 : 1)'
}

pipeline() { docker compose run --rm pipeline "$@"; }

# ---------- configuração ----------
carregar_env() {
  if [[ ! -f .env ]]; then
    cp .env.example .env
    log "Criado .env a partir de .env.example"
  fi
  ler_dados_dir
}

# Lê só DADOS_DIR, sem executar o arquivo (sem .env, o padrão do .env.example).
ler_dados_dir() {
  local linha arquivo=.env
  [[ -f "$arquivo" ]] || arquivo=.env.example
  linha=$(grep -E '^DADOS_DIR=' "$arquivo" | tail -n1 || true)
  DADOS_DIR_HOST="${linha#DADOS_DIR=}"
  # Aspas, como o Compose as lê (um disco externo costuma ter espaço no nome: "/Volumes/Meu Disco/dados").
  DADOS_DIR_HOST="${DADOS_DIR_HOST%\"}"; DADOS_DIR_HOST="${DADOS_DIR_HOST#\"}"
  DADOS_DIR_HOST="${DADOS_DIR_HOST%\'}"; DADOS_DIR_HOST="${DADOS_DIR_HOST#\'}"
  DADOS_DIR_HOST="${DADOS_DIR_HOST:-./dados}"
  DADOS_DIR_HOST="${DADOS_DIR_HOST/#\~/$HOME}"
}

# Memória que o Docker enxerga, em MB: no Linux, a da máquina; no Mac e no Windows, a da VM do Docker Desktop.
memoria_docker_mb() { echo $(( $(docker info --format '{{.MemTotal}}') / 1024 / 1024 )); }

# Os valores do Postgres no docker-compose.yml pensam em 16 GB. Com menos de 7 GB no Docker, as cargas derrubariam o
# banco: grava no .env, uma vez, valores proporcionais (o .env vale para todo `docker compose`, não só para este script).
ajustar_memoria() {
  grep -q '^PG_SHARED_BUFFERS=' .env && return 0
  local mb
  mb=$(memoria_docker_mb)
  (( mb >= 7 * 1024 )) && return 0
  warn "O Docker tem só $(( mb / 1024 )) GB de memória: o Postgres vai usar menos e as cargas ficam mais lentas. Para dar mais, Docker Desktop → Settings → Resources (depois apague as linhas PG_* do .env)."
  printf '\n# Gravado pelo ./run.sh: o Docker tem %s MB de memória (ver README.pt-BR.md, "Configuração").\nPG_SHARED_BUFFERS=%sMB\nPG_EFFECTIVE_CACHE_SIZE=%sMB\nPG_MAINTENANCE_WORK_MEM=%sMB\n' \
    "$mb" $(( mb / 4 )) $(( mb / 2 )) $(( mb / 16 )) >> .env
}

UFS="${UFS:-${UF:-}}"  # UF=XX (uma só) continua valendo
PARALELO="${PARALELO:-4}"
CAR_PUBLICADO_EM="${CAR_PUBLICADO_EM:-}"
MAPBIOMAS_PUBLICADO_EM="${MAPBIOMAS_PUBLICADO_EM:-}"
ALERTAS_ARQUIVO="${ALERTAS_ARQUIVO:-/dados/alerts_with_intersections/alerts_with_intersections.shp}"
BIOMAS_ARQUIVO="${BIOMAS_ARQUIVO:-/dados/BIOMAS/lml_bioma_e250k_v20250911_A.shp}"

# Converte um caminho do container (/dados/..., /db/...) para o do host.
caminho_host() {
  case "$1" in
    /dados/*) printf '%s/%s' "$DADOS_DIR_HOST" "${1#/dados/}" ;;
    /db/*)    printf '%s/%s' "$PWD/db" "${1#/db/}" ;;
    *)        printf '%s' "$1" ;;
  esac
}

# Sucesso se todos os arquivos existem; senão avisa qual falta.
tem_arquivos() {
  local f ok=0
  for f in "$@"; do
    if [[ ! -e "$(caminho_host "$f")" ]]; then
      warn "Arquivo não encontrado: $f (host: $(caminho_host "$f"))"
      ok=1
    fi
  done
  return $ok
}

# ---------- etapas ----------
# As travas são geradas no Python de cada imagem: 3.12 na API (python:3.12-slim), 3.14 na pipeline (o da imagem do GDAL).
deps() {
  local atualizar=''
  [[ "${1:-}" == --atualizar ]] && atualizar='--upgrade'
  log "Travando as dependências da API (Python 3.12)"
  docker run --rm -v "$PWD/api:/w" -w /w python:3.12-slim sh -c "
    pip install -q --root-user-action=ignore pip-tools &&
    pip-compile -q $atualizar --generate-hashes --strip-extras -o requirements.txt pyproject.toml &&
    pip-compile -q $atualizar --generate-hashes --strip-extras --extra teste -o requirements-dev.txt pyproject.toml"
  log "Travando as dependências da pipeline (Python 3.14)"
  docker run --rm -v "$PWD/pipeline:/w" -w /w python:3.14-slim sh -c "
    pip install -q --root-user-action=ignore pip-tools &&
    pip-compile -q $atualizar --generate-hashes --strip-extras -o requirements.txt requirements.in"
  log "Reconstrua as imagens: docker compose build api pipeline"
}

# Os tipos do frontend saem do OpenAPI da API (api/nodaltrace/tipos_ts.py), rodado no container dela.
tipos() {
  ( manter_atestacao; docker compose up -d --no-deps api )
  docker compose exec -T api python -m nodaltrace.tipos_ts > web/src/api/contrato.ts
  log "web/src/api/contrato.ts atualizado"
}

infra() {
  carregar_env
  ajustar_memoria
  log "Subindo PostGIS, Martin e API"
  docker compose up -d --build --wait db
  # Em subshell: os segredos que manter_atestacao reaproveita só chegam ao compose, não ao resto do script (nem ao Vite).
  ( manter_atestacao; docker compose up -d --build martin api )
}

migrar() {
  log "Aplicando migrações"
  pipeline migrar
  # O Martin só enxerga as funções de tile que existiam quando subiu: reinicia para pegar as novas.
  log "Reiniciando o Martin"
  docker compose up -d --force-recreate --no-deps martin
}

dados() {
  carregar_env
  # Sem a pasta (ex.: disco externo desconectado), o Docker no Linux a criaria vazia, como root, e as cargas pulariam tudo.
  if [[ ! -d "$DADOS_DIR_HOST" ]]; then
    warn "Pasta das bases não encontrada: $DADOS_DIR_HOST (DADOS_DIR no .env; disco externo desconectado?). Pulando as cargas."
    return 0
  fi

  # CAR: uma pasta por estado em dados/AREA_IMOVEL/<UF>/ (AREA_IMOVEL_1.shp…, ou os .zip do SICAR). Um comando só
  # carrega todos, vários ao mesmo tempo, com os municípios do IBGE que faltarem.
  if [[ -n "$UFS" ]] || find "$DADOS_DIR_HOST/AREA_IMOVEL" -mindepth 2 -maxdepth 2 \
       \( -iname '*.shp' -o -iname '*.gpkg' -o -iname '*.zip' \) -print -quit 2>/dev/null | grep -q .; then
    log "CAR ${UFS:-de todos os estados}"
    # shellcheck disable=SC2086
    pipeline car ${UFS:+--uf $UFS} ${CAR_PUBLICADO_EM:+--publicado-em "$CAR_PUBLICADO_EM"} --paralelo "$PARALELO"
  else
    warn "Pulando CAR: nenhum estado em $DADOS_DIR_HOST/AREA_IMOVEL/<UF>/ (ver dados/README.md)."
  fi

  if tem_arquivos "$ALERTAS_ARQUIVO"; then
    log "MapBiomas Alerta"
    pipeline mapbiomas --alertas "$ALERTAS_ARQUIVO" ${MAPBIOMAS_PUBLICADO_EM:+--publicado-em "$MAPBIOMAS_PUBLICADO_EM"}
  else
    warn "Pulando MapBiomas."
  fi

  if tem_arquivos "$BIOMAS_ARQUIVO"; then
    log "Biomas do IBGE"
    pipeline biomas --arquivo "$BIOMAS_ARQUIVO"
  else
    warn "Pulando biomas. Baixe do IBGE (ver dados/README.md)."
  fi
}

limpar() {
  if [[ "${1:-}" != --sim ]]; then
    read -r -p "Isso APAGA as bases carregadas e os relatórios emitidos. Continuar? [s/N] " r
    [[ "$r" == [sS] ]] || { echo "Cancelado."; return; }
  fi
  log "Apagando referências e relatórios"
  pipeline limpar
  # A API guarda caches em memória e o Martin guarda tiles: reinicia os dois para não servirem o antigo.
  log "Reiniciando API e Martin"
  docker compose restart api martin
}

# ---------- atestação na Solana (devnet) ----------
# Segredos: as senhas dos cofres são lidas com read -s (ou de uma env já exportada) e, como o segredo HMAC, só existem
# na env deste processo e na dos containers. Nada disso é gravado em arquivo nem passado na linha de comando.
CHAVES_DIR=attestor/chaves
NOMES_CHAVES=(autoridade atestador)
IMAGEM_ATTESTOR=nodaltrace-attestor:local
# O attestor roda com o dono dos cofres (arquivos 0600).
NT_UID=$(id -u); NT_GID=$(id -g); export NT_UID NT_GID

attestor_imagem() { docker compose --profile solana build attestor; }

# CLI do attestor num container descartável, sem rede e sem log, com os cofres montados (só leitura, salvo com
# --gravar). As senhas chegam pelas envs NT_CHAVES_SENHA e NT_CHAVES_SENHA_AUTORIDADE, só as que estiverem exportadas.
attestor_cli() {
  local modo=ro
  if [[ "$1" == --gravar ]]; then modo=rw; shift; fi
  docker run --rm -i --network none --log-driver none --user "$NT_UID:$NT_GID" \
    -e NT_CHAVES_SENHA -e NT_CHAVES_SENHA_AUTORIDADE \
    -v "$PWD/$CHAVES_DIR:/app/chaves:$modo" --entrypoint node "$IMAGEM_ATTESTOR" dist/cli.js "$@"
}

# Pede uma senha sem ecoar e a exporta só para este processo. Já exportada no shell, usa essa.
#   pedir_senha <env> <descrição> [nova]
# A autoridade tem senha própria (NT_CHAVES_SENHA_AUTORIDADE), que só o solana-chaves e o solana-setup --confirmar
# pedem; o atestador usa NT_CHAVES_SENHA.
pedir_senha() {
  local var="$1" desc="$2" s s2
  [[ -n "${!var:-}" ]] && return
  [[ -t 0 ]] || die "A senha $desc precisa de um terminal interativo. Rode o comando direto num terminal."
  read -r -s -p "Senha $desc: " s; echo >&2
  [[ -n "$s" ]] || die "Senha vazia."
  if [[ "${3:-}" == nova ]]; then
    (( ${#s} >= 12 )) || die "Use uma senha de pelo menos 12 caracteres."
    read -r -s -p "Repita a senha: " s2; echo >&2
    [[ "$s" == "$s2" ]] || die "As senhas não conferem."
  fi
  printf -v "$var" '%s' "$s"
  export "${var?}"
}
senha_comum() { pedir_senha NT_CHAVES_SENHA "do cofre do atestador" "$@"; }
senha_autoridade() { pedir_senha NT_CHAVES_SENHA_AUTORIDADE "do cofre da autoridade (diferente da do atestador)" "$@"; }

tem_chaves() {
  local n
  for n in "${NOMES_CHAVES[@]}"; do
    [[ -f "$CHAVES_DIR/$n.json" ]] || die "Falta a chave $n em $CHAVES_DIR/. Rode ./run.sh solana-chaves."
  done
}

segredo() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

# Pergunta de sim ou não; só "s" confirma.
sim() { local r; read -r -p "$1 [s/N] " r; [[ "$r" == [sS] ]]; }

# Põe em FALTAM os cofres que ainda não existem.
chaves_faltando() {
  local n
  FALTAM=()
  for n in "${NOMES_CHAVES[@]}"; do [[ -f "$CHAVES_DIR/$n.json" ]] || FALTAM+=("$n"); done
}

# Pede as senhas para gravar os cofres que faltam (os nomes em $@): a do atestador, nova ou conferida no cofre que já
# existe, e a da autoridade, nova e diferente da do atestador.
senhas_para_gravar() {
  local n autoridade=0
  for n in "$@"; do [[ "$n" == autoridade ]] && autoridade=1; done
  # Só a autoridade faltando: pede a do atestador mesmo assim, para conferir que a da autoridade é diferente dela.
  if [[ -f "$CHAVES_DIR/atestador.json" ]]; then
    senha_comum
    attestor_cli conferir atestador || die "A senha não abre o cofre atestador."
  else
    senha_comum nova
  fi
  if (( autoridade )); then
    senha_autoridade nova
    [[ "$NT_CHAVES_SENHA_AUTORIDADE" != "${NT_CHAVES_SENHA:-}" ]] \
      || die "A senha da autoridade tem de ser diferente da do atestador."
  fi
}

pasta_chaves() {
  mkdir -p "$CHAVES_DIR"
  chmod 700 "$CHAVES_DIR"
}

solana_chaves() {
  log "Imagem do attestor"
  attestor_imagem
  pasta_chaves
  local n
  chaves_faltando
  if (( ${#FALTAM[@]} )); then
    senhas_para_gravar "${FALTAM[@]}"
    for n in "${FALTAM[@]}"; do
      log "Gerando a chave $n"
      attestor_cli --gravar gerar "$n"
    done
  else
    log "As duas chaves já existem em $CHAVES_DIR/"
  fi
  unset NT_CHAVES_SENHA NT_CHAVES_SENHA_AUTORIDADE
  log "Endereços"
  for n in "${NOMES_CHAVES[@]}"; do printf '  %-11s %s\n' "$n" "$(attestor_cli endereco "$n")"; done
  cat <<'EOF'

Abasteça na devnet (nada é pedido automaticamente), em https://faucet.solana.com (rede "devnet") ou de uma carteira
do solana-cli: solana transfer <endereço> 1 --url devnet --allow-unfunded-recipient
  atestador   taxa e aluguel de cada conta de atestação (uns milésimos de SOL por relatório): 1 SOL sobra
  autoridade  taxa e aluguel da credencial e do schema (solana-setup --confirmar): 0,05 SOL sobra
Depois: ./run.sh solana-setup
EOF
}

solana_setup() {
  local args=()
  case "${1:-}" in
    '') ;;
    --confirmar) args=(--confirmar) ;;
    *) die "Uso: ./run.sh solana-setup [--confirmar]" ;;
  esac
  carregar_env
  tem_chaves
  attestor_imagem
  # Só o envio decifra a autoridade (que assina e paga): o plano lê endereços e a rede.
  if (( ${#args[@]} )); then
    senha_autoridade
    attestor_cli conferir autoridade || die "A senha da autoridade não abre o cofre autoridade."
  fi
  NT_ATESTADOR=$(attestor_cli endereco atestador)
  export NT_ATESTADOR
  log "Setup do SAS na devnet${args[*]:+ (enviando)}"
  # Serviço descartável à parte (attestor-setup): só ele monta autoridade.json e recebe a senha dela; o container
  # e a env dele somem no fim (--rm).
  local rc=0
  docker compose --profile solana-setup run --rm --no-deps attestor-setup ${args[@]+"${args[@]}"} || rc=$?
  unset NT_CHAVES_SENHA_AUTORIDADE
  (( rc == 0 )) || die "O setup falhou (código $rc)."
  if (( ! ${#args[@]} )); then
    printf '\nNada foi enviado. Revise o plano acima e rode: ./run.sh solana-setup --confirmar\n'
  fi
}

solana_up() {
  carregar_env
  tem_chaves
  attestor_imagem
  # Só a senha do atestador: a da autoridade nunca entra no solana-up.
  unset NT_CHAVES_SENHA_AUTORIDADE
  senha_comum
  attestor_cli conferir atestador || die "A senha não abre o cofre atestador."
  NT_AUTORIDADE=$(attestor_cli endereco autoridade)
  # Segredo de sessão, novo a cada subida: nada a guardar. Attestor e API são recriados juntos com ele.
  NT_ATTESTOR_SEGREDO=$(segredo)
  NT_ATTESTOR_URL=http://attestor:8790
  export NT_AUTORIDADE NT_ATTESTOR_SEGREDO NT_ATTESTOR_URL
  log "Subindo o attestor"
  docker compose --profile solana up -d --no-deps --wait --force-recreate attestor
  # A API precisa do segredo novo do attestor. --no-deps: banco e Martin ficam como estão.
  log "Recriando só a API com o segredo do attestor"
  docker compose up -d --no-deps api
  unset NT_CHAVES_SENHA
  printf '\nAtestação ligada (devnet). Confira com ./run.sh solana-saude\n'
}

# /saude exige HMAC (CONTRATO.md §5): assina de dentro do container do attestor, que já tem o segredo na env.
# shellcheck disable=SC2016  # o ${...} é do JavaScript, não do shell
SAUDE_JS='
import { createHmac } from "node:crypto";
const tempo = String(Math.floor(Date.now() / 1000)), caminho = "/saude";
const assinatura = createHmac("sha256", process.env.NT_ATTESTOR_SEGREDO)
  .update(`${tempo}\nGET\n${caminho}\n`).digest("hex");
const r = await fetch(`http://127.0.0.1:${process.env.PORT || 8790}${caminho}`,
  { headers: { "X-NT-Tempo": tempo, "X-NT-Assinatura": assinatura } });
const texto = await r.text();
try { console.log(JSON.stringify(JSON.parse(texto), null, 2)); } catch { console.log(texto); }
process.exit(r.ok ? 0 : 1);
'

attestor_no_ar() {
  docker compose --profile solana ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx attestor
}

solana_saude() {
  attestor_no_ar || die "O attestor não está rodando. Rode ./run.sh solana-up."
  docker compose --profile solana exec -T attestor node --input-type=module -e "$SAUDE_JS"
}

# Com a atestação ligada, recriar a API sem o segredo do attestor a desligaria sem aviso: reaproveita os segredos da
# sessão, lidos da env do attestor que está rodando (só em memória; nada é gravado).
manter_atestacao() {
  attestor_no_ar || return 0
  NT_ATTESTOR_SEGREDO=$(docker compose --profile solana exec -T attestor printenv NT_ATTESTOR_SEGREDO) || return 0
  NT_AUTORIDADE=$(docker compose --profile solana exec -T attestor printenv NT_AUTORIDADE || true)
  NT_ATTESTOR_URL=http://attestor:8790
  export NT_ATTESTOR_SEGREDO NT_AUTORIDADE NT_ATTESTOR_URL
}

# ---------- ./run.sh solana: do zero à atestação ligada ----------
# Saldos e airdrop (attestor/src/fundos.ts), num container descartável sem cofre nenhum (só endereços).
#   saldos: sai com 3 se alguma das duas contas está abaixo do piso dela
fundos() { docker compose --profile solana-setup run --rm --no-deps -T attestor-fundos "$@"; }
setup_plano() { NT_CHAVES_SENHA_AUTORIDADE='' docker compose --profile solana-setup run --rm --no-deps -T attestor-setup; }
setup_enviar() { docker compose --profile solana-setup run --rm --no-deps -T attestor-setup --confirmar; }

# Grava os cofres que faltam a partir dos pares do solana-cli que a pessoa já tem (Enter gera um novo). O arquivo
# entra pelo stdin do container: só o cofre cifrado fica em attestor/chaves/.
importar_contas() {
  local n arq end
  senhas_para_gravar "${FALTAM[@]}"
  for n in "${FALTAM[@]}"; do
    read -r -p "Arquivo do solana-cli para $n (Enter cria uma nova): " arq
    arq="${arq/#\~/$HOME}"
    if [[ -z "$arq" ]]; then
      end=$(attestor_cli --gravar gerar "$n") || die "Não consegui gerar a chave $n."
      printf '  %-11s %s (nova)\n' "$n" "$end"
    else
      [[ -f "$arq" ]] || die "Arquivo não encontrado: $arq"
      end=$(attestor_cli --gravar importar "$n" /dev/stdin < "$arq") || die "Não consegui importar $arq como $n."
      printf '  %-11s %s\n' "$n" "$end"
    fi
  done
}

# Saldo para o setup e para atestar. Com contas novas, airdrop de 1 SOL da devnet; com as da pessoa, pergunta antes. Se
# o faucet do RPC recusar, mostra como abastecer e espera.
abastecer() {
  local novas="$1" rc=0
  log "Saldos na devnet"
  fundos saldos || rc=$?
  (( rc == 0 || rc == 3 )) || die "Não consegui ler os saldos na devnet."
  if (( rc == 3 )) && { (( novas )) || sim "Pedir airdrop de 1 SOL da devnet para as contas abaixo do piso?"; }; then
    log "Airdrop da devnet"
    fundos airdrop || true
    rc=0; fundos saldos >/dev/null || rc=$?
  fi
  while (( rc == 3 )); do
    cat <<EOF

Alguma conta está abaixo do piso. Abasteça em https://faucet.solana.com (rede "devnet") ou de uma carteira do
solana-cli (solana transfer <endereço> 1 --url devnet --allow-unfunded-recipient):
  atestador   $NT_ATESTADOR  (1 SOL)
  autoridade  $NT_AUTORIDADE  (0,05 SOL)
EOF
    read -r -p "Depois de abastecer, aperte Enter (Ctrl+C sai): " _
    rc=0; fundos saldos || rc=$?
  done
}

# Credencial e schema no SAS: mostra o plano e só pede senha e confirmação se faltar criar algo.
setup_guiado() {
  local plano
  log "Credencial e schema no SAS"
  plano=$(setup_plano) || { printf '%s\n' "$plano"; die "O plano do setup falhou (ver a simulação acima)."; }
  printf '%s\n' "$plano"
  [[ "$plano" == *"nada a criar."* ]] && return 0
  sim "Enviar o setup (credencial, schema, assinante autorizado) na devnet?" \
    || die "Setup não enviado: sem ele não dá para atestar. Rode ./run.sh solana de novo quando quiser."
  senha_autoridade
  attestor_cli conferir autoridade || die "A senha da autoridade não abre o cofre autoridade."
  setup_enviar || die "O setup falhou."
}

solana() {
  [[ -t 0 ]] || die "O ./run.sh solana pergunta e pede senhas: rode-o num terminal."
  carregar_env
  log "Imagem do attestor"
  attestor_imagem
  pasta_chaves
  local n r end novas=0
  chaves_faltando
  if (( ${#FALTAM[@]} )); then
    printf '\nContas da Solana (faltam: %s)\n' "${FALTAM[*]}"
    printf '  1) criar novas, com airdrop de 1 SOL da devnet\n  2) usar as que você já tem (arquivos .json do solana-cli)\n'
    read -r -p "Escolha [1/2]: " r
    case "$r" in
      1|'')
        senhas_para_gravar "${FALTAM[@]}"
        for n in "${FALTAM[@]}"; do
          end=$(attestor_cli --gravar gerar "$n") || die "Não consegui gerar a chave $n."
          printf '  %-11s %s\n' "$n" "$end"
        done
        novas=1 ;;
      2) importar_contas ;;
      *) die "Escolha 1 ou 2." ;;
    esac
  else
    log "As duas contas já existem em $CHAVES_DIR/"
  fi
  NT_AUTORIDADE=$(attestor_cli endereco autoridade)
  NT_ATESTADOR=$(attestor_cli endereco atestador)
  export NT_AUTORIDADE NT_ATESTADOR
  abastecer "$novas"
  setup_guiado
  # O solana-up pede só a senha do atestador (reaproveita a já digitada) e nunca recebe a da autoridade.
  unset NT_CHAVES_SENHA_AUTORIDADE
  solana_up
  log "Saúde do attestor"
  solana_saude
}

# No ./run.sh (all), antes do frontend: oferece ligar a atestação, se estiver desligada. Roda num processo à parte
# para que um erro ou um Ctrl+C lá dentro não impeça o frontend de subir.
oferecer_solana() {
  if attestor_no_ar; then
    log "Atestação na Solana ligada (devnet)"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    warn "Atestação na Solana desligada. Para ligar, rode ./run.sh solana num terminal."
    return 0
  fi
  printf '\n'
  if sim "A atestação na Solana (devnet) está desligada. Ligar agora?"; then
    trap ':' INT
    bash "./$(basename "$0")" solana || warn "A atestação não foi ligada; o resto do ambiente segue. Para tentar de novo: ./run.sh solana"
    trap - INT
  else
    echo "Para ligar depois: ./run.sh solana"
  fi
}

web() {
  node_ok || die "Precisa do Node 22.12+ com npm (tem: $(node -v 2>/dev/null || echo nenhum)). Instale pelo https://nodejs.org ou, com nvm, rode nvm install (o .nvmrc diz a versão)."
  cd web
  # npm ci instala exatamente o package-lock.json: as mesmas versões em toda máquina. Refaz depois de um pull que
  # mude o lock (o npm grava a cópia instalada em node_modules/.package-lock.json).
  if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
    log "Instalando as dependências do frontend (npm ci)"
    npm ci
  fi
  log "Frontend em http://localhost:5173"
  npm run dev
}

# ---------- diagnóstico ----------
PROJETO_COMPOSE="${COMPOSE_PROJECT_NAME:-nodaltrace}"
FALHAS=0
ok()    { printf '  \033[1;32mok\033[0m  %s\n' "$*"; }
nota()  { printf '  \033[1;33m!!\033[0m  %s\n' "$*"; }
falha() { printf '  \033[1;31mxx\033[0m  %s\n' "$*"; FALHAS=$((FALHAS + 1)); }
# ok com a 1ª mensagem se o comando (do 3º argumento em diante) der certo; senão, !! com a 2ª.
ok_ou_nota() { local sim="$1" nao="$2"; shift 2; if "$@" >/dev/null 2>&1; then ok "$sim"; else nota "$nao"; fi; }

# Porta em uso por outro programa (não por um contêiner deste projeto)? Pelo /dev/tcp do bash, sem lsof nem nc.
porta_ocupada() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || return 1
  [[ "$(docker ps --filter "publish=$1" --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null)" != "$PROJETO_COMPOSE" ]]
}

banco_no_ar() { docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx db; }
consultar() { docker compose exec -T db psql -U nodaltrace -d nodaltrace -Atc "$1" 2>/dev/null; }

# O que está carregado no banco e o que falta para cada parte do app.
resumo_bases() {
  local linha ufs mapbiomas biomas
  linha=$(consultar "SELECT coalesce((SELECT string_agg(DISTINCT uf, ' ' ORDER BY uf) FROM ref.car_carga), '')
                       || '|' || EXISTS (SELECT 1 FROM ref.camada WHERE tipo = 'mapbiomas')
                       || '|' || EXISTS (SELECT 1 FROM ref.bioma)" || true)
  if [[ -z "$linha" ]]; then
    nota "Banco sem as migrações ainda: rode ./run.sh"
    return 0
  fi
  IFS='|' read -r ufs mapbiomas biomas <<< "$linha"
  ok_ou_nota "No banco: CAR de ${ufs}" "No banco: nenhum CAR (o mapa abre sem imóveis; ver dados/README.md)" test -n "$ufs"
  ok_ou_nota "No banco: MapBiomas Alerta" "No banco: sem MapBiomas Alerta (sem alertas nem a análise de desmatamento)" test "$mapbiomas" = true
  ok_ou_nota "No banco: biomas do IBGE" "No banco: sem os biomas do IBGE (sem a análise de bioma)" test "$biomas" = true
  printf '\n  Abra http://localhost:5173\n'
}

diagnostico() {
  local mb livre ufs
  FALHAS=0
  log "Diagnóstico ($SO $(uname -m)$(eh_wsl && echo ', WSL'))"

  if ! command -v docker >/dev/null; then
    falha "Docker não encontrado. $(dica_docker)"
  elif ! docker compose version >/dev/null 2>&1; then
    falha "Plugin 'docker compose' (v2) não encontrado. $(dica_docker)"
  elif ! docker info >/dev/null 2>&1; then
    falha "Docker parado ou sem permissão. $(dica_docker)"
  else
    mb=$(memoria_docker_mb)
    ok "Docker $(docker version --format '{{.Server.Version}}'), compose $(docker compose version --short), $(( mb / 1024 )) GB de memória"
    if (( mb < 7 * 1024 )); then
      nota "Pouca memória no Docker: o ./run.sh reduz a do Postgres (cargas mais lentas). Mais memória: Docker Desktop → Settings → Resources"
    fi
  fi

  if node_ok; then
    ok "Node $(node -v), npm $(npm -v)"
  else
    falha "Precisa do Node 22.12+ com npm (tem: $(node -v 2>/dev/null || echo nenhum)). https://nodejs.org ou nvm install (versão no .nvmrc)"
  fi
  ok_ou_nota "Python 3 (só para ./run.sh test)" "Sem python3: só o ./run.sh test precisa dele" command -v python3

  for p in 5433 3000 8000; do
    porta_ocupada "$p" && falha "Porta $p ocupada por outro programa: o Compose não vai subir (feche-o ou mude a porta no docker-compose.yml)"
  done
  porta_ocupada 5173 && nota "Porta 5173 ocupada: o Vite vai usar outra; abra a URL que ele mostrar"

  livre=$(df -Pk . | awk 'NR == 2 { print int($4 / 1024 / 1024) }')
  if (( livre < 15 )); then
    nota "Só ${livre} GB livres no disco: o CAR de um estado e o MapBiomas ocupam alguns GB no banco"
  else
    ok "${livre} GB livres no disco"
  fi

  ler_dados_dir
  if [[ ! -d "$DADOS_DIR_HOST" ]]; then
    nota "Pasta das bases não encontrada: $DADOS_DIR_HOST (DADOS_DIR no .env; disco externo desconectado?)"
  else
    ufs=$(find "$DADOS_DIR_HOST/AREA_IMOVEL" -mindepth 2 -maxdepth 2 \( -iname '*.shp' -o -iname '*.gpkg' -o -iname '*.zip' \) 2>/dev/null \
            | sed 's#.*/AREA_IMOVEL/\([^/]*\)/.*#\1#' | sort -u | tr '\n' ' ' || true)
    ok_ou_nota "Para carregar, em $DADOS_DIR_HOST: CAR de ${ufs% }" "Para carregar, em $DADOS_DIR_HOST: nenhum CAR (ver dados/README.md)" \
      test -n "$ufs"
    ok_ou_nota "Para carregar: MapBiomas Alerta" "Para carregar: sem o MapBiomas Alerta" test -e "$(caminho_host "$ALERTAS_ARQUIVO")"
    ok_ou_nota "Para carregar: biomas do IBGE" "Para carregar: sem os biomas do IBGE" test -e "$(caminho_host "$BIOMAS_ARQUIVO")"
  fi

  if grep -qE '^VITE_MAPBOX_TOKEN=pk\.' web/.env.local 2>/dev/null; then
    ok "Token do Mapbox em web/.env.local"
  else
    nota "Sem token do Mapbox (opcional): o mapa abre sem a imagem de satélite (ver web/.env.example)"
  fi

  if (( FALHAS == 0 )) && banco_no_ar; then resumo_bases; fi
  (( FALHAS == 0 ))
}

# ---------- testes ----------
# Pipeline (unidade e integração das cargas) e API sobre o banco nodaltrace_teste, que tests/preparar_banco_teste.sh
# recria com a amostra de dados reais de tests/dados/ (casos.json): o banco de desenvolvimento não é tocado. Roda as
# duas suítes mesmo que uma falhe; devolve 1 se alguma falhou.
testes_com_banco() {
  local falhou=0 senha url
  senha=$(sed -n 's/^POSTGRES_PASSWORD=//p' .env | tail -n1)
  url="postgresql://nodaltrace:${POSTGRES_PASSWORD:-${senha:-nodaltrace}}@db:5432/nodaltrace_teste"
  docker compose up -d --wait db
  log "Banco de testes (tests/preparar_banco_teste.sh)"
  if ! ./tests/preparar_banco_teste.sh; then
    warn "O banco de testes não foi montado: rodam só os testes de unidade da pipeline; os da API ficam de fora."
    docker compose run --rm -T --entrypoint python3 pipeline -m unittest discover -s tests
    return 1
  fi
  log "Testes da pipeline"
  DADOS_DIR=./tests/dados docker compose run --rm -T -e NT_BANCO_TESTE=1 -e DATABASE_URL="$url" \
    --entrypoint python3 pipeline -m unittest discover -s tests || falhou=1
  log "Testes da API"
  # Sobe a API se não estiver no ar (ou a recria, se o docker-compose.yml mudou), sem desligar a atestação.
  ( manter_atestacao; docker compose up -d --no-deps api )
  # Sem attestor nos testes: nada sai para a rede (a API também recusa registrar relatórios do banco de testes).
  docker compose exec -T -e DATABASE_URL="$url" -e NT_ATTESTOR_URL= -e NT_ATTESTOR_SEGREDO= api pytest || falhou=1
  return "$falhou"
}

# ---------- comandos ----------
case "${1:-all}" in
  -h|--help|help|diagnostico|web) ;;
  *) exigir_docker ;;
esac

case "${1:-all}" in
  all)
    diagnostico || die "Corrija os itens marcados com xx e rode ./run.sh de novo."
    infra
    migrar
    dados
    log "Bases carregadas"
    resumo_bases
    oferecer_solana
    web
    ;;
  diagnostico) diagnostico ;;
  infra)  infra ;;
  migrar) carregar_env; migrar ;;
  dados)  dados ;;
  web)    web ;;
  limpar) limpar "${2:-}" ;;
  deps)   deps "${2:-}" ;;
  tipos)  tipos ;;
  test)
    # Paridade entre pacotes (no host); pipeline e API sobre o banco de testes, montado com a amostra de tests/dados/.
    # Roda todas as suítes mesmo que uma falhe; o código de saída diz se alguma falhou.
    falhou=0
    carregar_env
    if command -v python3 >/dev/null; then
      python3 -m unittest discover -s tests || falhou=1
    else
      warn "Sem python3 no host: o teste de paridade (tests/) não rodou."; falhou=1
    fi
    testes_com_banco || falhou=1
    exit "$falhou" ;;
  psql)   docker compose exec db psql -U nodaltrace -d nodaltrace ;;
  status) docker compose ps ;;
  logs)   docker compose logs -f ;;
  down)   docker compose down ;;
  reset)
    read -r -p "Isso APAGA o banco (volume pgdata). Continuar? [s/N] " r
    [[ "$r" == [sS] ]] && docker compose down -v || echo "Cancelado."
    ;;
  solana)        solana ;;
  solana-chaves) solana_chaves ;;
  solana-setup)  solana_setup "${2:-}" ;;
  solana-up)     solana_up ;;
  solana-saude)  solana_saude ;;
  solana-down)   docker compose --profile solana rm -sf attestor ;;
  -h|--help|help) sed -n '2,/^$/p' "$0" ;;
  *) die "Comando desconhecido: $1 (use ./run.sh help)" ;;
esac
