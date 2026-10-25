#!/usr/bin/env bash
# Implantação do NodalTrace no Google Cloud (ver README.pt-BR.md, "Nuvem (Google Cloud)").
#
# Uso: deploy/gcp.sh <comando>
#
#   infra             APIs, Artifact Registry, buckets (dados e imagens), conta de serviço, Cloud SQL (PostGIS 17) e o
#                     segredo da conexão
#   dump              exporta o banco local (Compose) e envia ao bucket
#   importar          importa o dump no Cloud SQL e atualiza as estatísticas
#   proxy             abre o Cloud SQL em 127.0.0.1:5434 (para psql e conferir), com a conta do gcloud
#   conferir          compara o número de linhas de cada tabela, local x nuvem (com o proxy aberto)
#   imagens           constrói as 4 imagens no Cloud Build (tag em deploy/.tag)
#   servico           republica o serviço (deploy/service.yaml) com a última tag, no modo de deploy/.modo (sem ele, teste)
#   candidata         como `servico`, mas a revisão nova sobe sem tráfego, com a tag `candidata` (modo de teste)
#   promover          manda todo o tráfego para a última revisão pronta (depois de conferir a candidata)
#   teste             modo de teste: só quem tem papel no projeto, por `abrir`; sem balanceador; desliga sem uso
#   abrir [tag]       abre o serviço em http://localhost:8090 com a sua conta (modo de teste; PORTA_APP muda a porta);
#                     `abrir candidata` abre a revisão sem tráfego
#   testador <e-mail>   libera o modo de teste para um colega (ele roda `deploy/gcp.sh abrir` com o gcloud dele)
#   remover-testador <e-mail>   retira
#   producao          modo de produção: https://$DOMINIO pelo balanceador com IAP, instância sempre ligada
#   migrar            aplica as migrações de db/ no Cloud SQL (job) e publica nova revisão do serviço
#   pipeline <args>   roda a pipeline num job, com o bucket em /dados (ex.: deploy/gcp.sh pipeline car --uf MT)
#   lb                balanceador com IP fixo e certificado para o domínio; mostra o IP para o DNS
#   iap <id> <segredo>  liga o IAP no balanceador com o cliente OAuth criado no Console
#   acesso <membro>   libera o acesso (user:pessoa@x.com, domain:x.com, ou só o e-mail)
#   remover <membro>  retira o acesso
#   acessos           lista quem tem acesso
#   parar | retomar   desliga/religa o Cloud SQL e a instância do serviço (economia entre demonstrações)
#   status            resumo do que existe
#
# Atestação na Solana (devnet; ver README.pt-BR.md, "Atestação na nuvem"):
#   solana            cifra com o Cloud KMS a chave do atestador (pede a senha do cofre de attestor/chaves, ou
#                     CHAVES_DIR) e guarda no Secret Manager, com o segredo HMAC; a senha e a chave da autoridade
#                     nunca vão para a nuvem. Rode de novo se trocar a chave
#   solana-rotacionar gera um segredo HMAC novo entre API e attestor e republica o serviço
#   solana-logs       subida e erros do attestor e do kms-exec (Cloud Logging)
#
# Variáveis opcionais: PROJETO, REGIAO, DOMINIO, NT_SOLANA_RPC (RPC da devnet), CHAVES_DIR (cofres da Solana).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[aviso]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[erro]\033[0m %s\n' "$*" >&2; exit 1; }

GCLOUD="${GCLOUD:-$(command -v gcloud || echo "$HOME/google-cloud-sdk/bin/gcloud")}"
[[ -x "$GCLOUD" ]] || die "gcloud não encontrado (defina GCLOUD=/caminho/do/gcloud)."

export PROJETO="${PROJETO:?defina PROJETO com o id do projeto no Google Cloud}"
export REGIAO="${REGIAO:-southamerica-east1}"
DOMINIO="${DOMINIO:-app.nodaltrace.com}"
INSTANCIA=nodaltrace-db
export SERVICO=nodaltrace
export REPO="$REGIAO-docker.pkg.dev/$PROJETO/nodaltrace"
BUCKET="$PROJETO-dados"
# Recortes das imagens históricas (api/nodaltrace/servicos/imagens.py), montado na API em /imagens.
export BUCKET_IMAGENS="$PROJETO-imagens"
export CONTA_SERVICO="nt-run@$PROJETO.iam.gserviceaccount.com"
CONTA_BUILD="nt-build@$PROJETO.iam.gserviceaccount.com"
export CONEXAO_SQL="$PROJETO:$REGIAO:$INSTANCIA"
DUMP_DIR="${DUMP_DIR:-$HOME/.cache/nodaltrace/nt_dump}"
PORTA_PROXY=5434
# Porta local do `abrir` (a 8080 costuma estar ocupada).
PORTA_APP="${PORTA_APP:-8090}"
PROXY_VERSAO=2.25.4
# Atestação: chave do Cloud KMS que cifra os segredos da Solana, RPC da devnet e a pasta dos cofres locais.
KMS_ANEL=nodaltrace
KMS_NOME=segredos
export KMS_CHAVE="projects/$PROJETO/locations/$REGIAO/keyRings/$KMS_ANEL/cryptoKeys/$KMS_NOME"
export SOLANA_RPC="${NT_SOLANA_RPC:-https://api.devnet.solana.com}"
# Caminho absoluto sem `realpath -m`, que só o GNU tem (o macOS não): o script já está na raiz do repositório.
CHAVES_DIR="${CHAVES_DIR:-attestor/chaves}"
[[ "$CHAVES_DIR" == /* ]] || CHAVES_DIR="$PWD/$CHAVES_DIR"
SEGREDOS_SOLANA=(nt-solana-atestador nt-solana-attestor-segredo nt-solana-autoridade)

g() { "$GCLOUD" --project "$PROJETO" --quiet "$@"; }
existe() { "$@" >/dev/null 2>&1; }

# Este script roda no Linux e no macOS: só ferramentas e opções POSIX (sem `mktemp --suffix`, `base64 -w`,
# `realpath -m`, envsubst, que o macOS não traz), e bash 3.2 (o do macOS).
temp_yaml() { local f; f=$(mktemp "${TMPDIR:-/tmp}/nt.XXXXXX") && mv "$f" "$f.yaml" && printf '%s.yaml' "$f"; }

# O envsubst com lista de variáveis: troca só ${NOME} e $NOME das listadas (as não definidas viram vazio).
substituir_vars() {
  python3 -c '
import os, re, sys
nomes = "|".join(map(re.escape, sys.argv[1].split()))
padrao = re.compile(r"\$(?:\{(" + nomes + r")\}|(" + nomes + r")(?![A-Za-z0-9_]))")
sys.stdout.write(padrao.sub(lambda m: os.environ.get(m.group(1) or m.group(2), ""), sys.stdin.read()))
' "$1"
}

# Papel no projeto. Logo depois de criada, a conta de serviço demora alguns segundos para valer no IAM: tenta de novo.
papel() {
  local i
  for i in 1 2 3 4 5 6; do
    g projects add-iam-policy-binding "$PROJETO" --member "serviceAccount:$1" --role "$2" --condition None >/dev/null \
      && return
    sleep 10
  done
  die "Não foi possível dar $2 a $1."
}

# Modo do serviço (deploy/.modo): teste (padrão) ou producao.
modo() { [[ -f deploy/.modo ]] && cat deploy/.modo || echo teste; }

# Revisão com a tag `candidata` ainda sem tráfego: `promover` antes de qualquer comando que crie revisão por
# `services update` (ele mantém o tráfego fixo na antiga, e a nova não serve ninguém).
sem_candidata() {
  g run services describe "$SERVICO" --region "$REGIAO" --format 'value(status.traffic.tag)' 2>/dev/null | grep -qw candidata \
    && die "Há uma revisão candidata sem tráfego: rode deploy/gcp.sh promover (ou deploy/gcp.sh teste) antes."
  true
}

tag() {
  [[ -f deploy/.tag ]] || die "Nenhuma imagem construída ainda: rode deploy/gcp.sh imagens."
  cat deploy/.tag
}

# ---------- infraestrutura ----------
infra() {
  log "APIs"
  g services enable sqladmin.googleapis.com run.googleapis.com artifactregistry.googleapis.com \
    cloudbuild.googleapis.com compute.googleapis.com iap.googleapis.com secretmanager.googleapis.com storage.googleapis.com \
    cloudresourcemanager.googleapis.com cloudkms.googleapis.com

  log "Artifact Registry e buckets"
  existe g artifacts repositories describe nodaltrace --location "$REGIAO" \
    || g artifacts repositories create nodaltrace --repository-format docker --location "$REGIAO"
  for b in "$BUCKET" "$BUCKET_IMAGENS"; do
    existe g storage buckets describe "gs://$b" \
      || g storage buckets create "gs://$b" --location "$REGIAO" --uniform-bucket-level-access
  done

  log "Conta de serviço do Cloud Run"
  existe g iam service-accounts describe "$CONTA_SERVICO" \
    || g iam service-accounts create nt-run --display-name "NodalTrace (Cloud Run)"
  for p in roles/cloudsql.client roles/secretmanager.secretAccessor; do
    papel "$CONTA_SERVICO" "$p"
  done
  g storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$CONTA_SERVICO" \
    --role roles/storage.objectViewer >/dev/null
  # Imagens: a API lê e grava os recortes, sem poder mexer nas permissões do bucket.
  g storage buckets add-iam-policy-binding "gs://$BUCKET_IMAGENS" --member "serviceAccount:$CONTA_SERVICO" \
    --role roles/storage.objectUser >/dev/null

  # A organização não dá papéis às contas padrão (iam.automaticIamGrantsForDefaultServiceAccounts): o Cloud Build
  # usa uma conta própria, que lê o código enviado, grava as imagens e os logs.
  log "Conta de serviço do Cloud Build"
  existe g iam service-accounts describe "$CONTA_BUILD" \
    || g iam service-accounts create nt-build --display-name "NodalTrace (Cloud Build)"
  for p in roles/artifactregistry.writer roles/logging.logWriter roles/storage.objectViewer; do
    papel "$CONTA_BUILD" "$p"
  done

  log "Cloud SQL (leva alguns minutos na criação)"
  # Ajustes do docker-compose.yml; shared_buffers e effective_cache_size o Cloud SQL deriva da máquina, e o jit (que
  # não é flag do Cloud SQL) fica desligado no papel nodaltrace, em `conferir`.
  existe g sql instances describe "$INSTANCIA" || g sql instances create "$INSTANCIA" \
    --database-version POSTGRES_17 --edition ENTERPRISE --tier db-custom-2-8192 --region "$REGIAO" \
    --availability-type zonal --storage-type SSD --storage-size 30 --storage-auto-increase \
    --backup-start-time 05:00 --enable-point-in-time-recovery --retained-transaction-log-days 7 \
    --deletion-protection --connector-enforcement REQUIRED \
    --database-flags work_mem=65536,maintenance_work_mem=1048576,random_page_cost=1.1,max_parallel_workers_per_gather=4
  # Desligado pelo `parar`, o Cloud SQL não responde sobre bancos e usuários: o resto do infra segue.
  if [[ "$(g sql instances describe "$INSTANCIA" --format 'value(settings.activationPolicy)')" == NEVER ]]; then
    warn "Cloud SQL desligado (deploy/gcp.sh parar): banco não conferido. Para conferir, deploy/gcp.sh retomar e de novo o infra."
  else
    existe g sql databases describe nodaltrace --instance "$INSTANCIA" \
      || g sql databases create nodaltrace --instance "$INSTANCIA"
  fi

  # Senha gerada uma vez e guardada só no Secret Manager, dentro das URLs de conexão: a do serviço (proxy em
  # 127.0.0.1) e a dos jobs (socket do Cloud SQL).
  if ! existe g secrets describe nt-database-url; then
    log "Usuário nodaltrace e segredos da conexão"
    local senha
    senha=$(openssl rand -hex 24)
    if existe g sql users describe nodaltrace --instance "$INSTANCIA"; then
      g sql users set-password nodaltrace --instance "$INSTANCIA" --password "$senha"
    else
      g sql users create nodaltrace --instance "$INSTANCIA" --password "$senha"
    fi
    printf 'postgresql://nodaltrace:%s@127.0.0.1:5432/nodaltrace' "$senha" \
      | g secrets create nt-database-url --replication-policy automatic --data-file -
    printf 'postgresql://nodaltrace:%s@/nodaltrace?host=/cloudsql/%s' "$senha" "$CONEXAO_SQL" \
      | g secrets create nt-database-url-socket --replication-policy automatic --data-file -
  fi
  log "Infraestrutura pronta"
}

# ---------- dados ----------
dump() {
  command -v docker >/dev/null || die "Docker não encontrado."
  log "Exportando o banco local (pg_dump 17 do próprio contêiner)"
  # Fora: as extensões do tiger/topology que a imagem postgis cria e o código não usa, e o staging do MapBiomas.
  docker compose exec -T db rm -rf /var/lib/postgresql/nt_dump
  docker compose exec -T db pg_dump -U nodaltrace -d nodaltrace -Fd -j 4 --no-owner --no-privileges \
    --exclude-schema tiger --exclude-schema tiger_data --exclude-schema topology \
    --exclude-extension postgis_tiger_geocoder --exclude-extension postgis_topology --exclude-extension fuzzystrmatch \
    --exclude-table ref.stg_mb_alerta -f /var/lib/postgresql/nt_dump
  rm -rf "$DUMP_DIR" && mkdir -p "$(dirname "$DUMP_DIR")"
  docker compose cp db:/var/lib/postgresql/nt_dump "$DUMP_DIR"
  docker compose exec -T db rm -rf /var/lib/postgresql/nt_dump
  du -sh "$DUMP_DIR"

  log "Enviando para gs://$BUCKET/dump/"
  g storage rm -r "gs://$BUCKET/dump" 2>/dev/null || true
  g storage cp -r "$DUMP_DIR" "gs://$BUCKET/dump"
}

importar() {
  log "Liberando a leitura do bucket para o Cloud SQL"
  local sa
  sa=$(g sql instances describe "$INSTANCIA" --format 'value(serviceAccountEmailAddress)')
  g storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$sa" \
    --role roles/storage.objectViewer >/dev/null

  log "Importando (pode levar dezenas de minutos)"
  # Uma thread por vCPU da instância (o Cloud SQL recusa mais).
  local cpus
  cpus=$(g sql instances describe "$INSTANCIA" --format 'value(settings.tier)' | sed -E -e 's/^db-custom-([0-9]+)-.*/\1/' -e t -e 's/.*/1/')
  # Assíncrono: a espera padrão do gcloud (10 min) acaba antes de uma importação deste tamanho.
  local op
  op=$(g sql import sql "$INSTANCIA" "gs://$BUCKET/dump" --database nodaltrace --user nodaltrace --parallel \
         --threads "$cpus" --async --format 'value(name)')
  g sql operations wait "$op" --timeout unlimited
  warn "Rode 'deploy/gcp.sh proxy' em outro terminal e depois 'deploy/gcp.sh conferir' (que também atualiza as estatísticas)."
}

senha_banco() {
  g secrets versions access latest --secret nt-database-url | sed -E 's#^postgresql://nodaltrace:([^@]+)@.*#\1#'
}

proxy() {
  # Binário do proxy em cache, autenticado com a conta do próprio gcloud (sem application-default login).
  # O binário do sistema e do processador desta máquina (linux|darwin, amd64|arm64).
  local so arq bin
  case "$(uname -s)" in Linux) so=linux ;; Darwin) so=darwin ;; *) die "Sistema sem binário do Cloud SQL Proxy: $(uname -s)" ;; esac
  case "$(uname -m)" in x86_64|amd64) arq=amd64 ;; arm64|aarch64) arq=arm64 ;; *) die "Processador sem binário do Cloud SQL Proxy: $(uname -m)" ;; esac
  bin="$HOME/.cache/nodaltrace/cloud-sql-proxy-$PROXY_VERSAO.$so.$arq"
  if [[ ! -x "$bin" ]]; then
    mkdir -p "$(dirname "$bin")"
    curl -fsSL -o "$bin" \
      "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v$PROXY_VERSAO/cloud-sql-proxy.$so.$arq"
    chmod +x "$bin"
  fi
  log "Cloud SQL em 127.0.0.1:$PORTA_PROXY (Ctrl+C para fechar)"
  PATH="$(dirname "$GCLOUD"):$PATH" "$bin" --gcloud-auth --port "$PORTA_PROXY" "$CONEXAO_SQL"
}

conferir() {
  export PGPASSWORD
  PGPASSWORD=$(senha_banco)
  local nuvem=(psql -h 127.0.0.1 -p "$PORTA_PROXY" -U nodaltrace -d nodaltrace -Atq)
  "${nuvem[@]}" -c 'SELECT 1' >/dev/null || die "Proxy fechado: rode 'deploy/gcp.sh proxy' em outro terminal."

  log "jit desligado (como no Compose) e estatísticas atualizadas na nuvem"
  "${nuvem[@]}" -c 'ALTER ROLE nodaltrace SET jit = off' -c 'SET client_min_messages = error' -c 'ANALYZE'

  log "Linhas por tabela (local x nuvem)"
  local tabelas="SELECT format('%I.%I', schemaname, relname) FROM pg_stat_user_tables
                 WHERE schemaname NOT IN ('tiger', 'tiger_data', 'topology') AND relname <> 'stg_mb_alerta' ORDER BY 1"
  local contar="SELECT string_agg(format('SELECT %L, count(*) FROM %s', t, t), ' UNION ALL ') FROM ($tabelas) x(t)"
  local consulta local_ nuvem_
  consulta=$(docker compose exec -T db psql -U nodaltrace -d nodaltrace -Atc "$contar")
  local_=$(docker compose exec -T db psql -U nodaltrace -d nodaltrace -AtF' ' -c "$consulta" | sort)
  nuvem_=$("${nuvem[@]}" -F' ' -c "$consulta" | sort)
  if diff <(echo "$local_") <(echo "$nuvem_"); then
    echo "Iguais: $(echo "$local_" | wc -l) tabelas."
  else
    die "Contagens diferentes (acima: < local, > nuvem)."
  fi
}

# ---------- imagens e serviço ----------
imagens() {
  local t token=''
  t="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
  git diff --quiet HEAD 2>/dev/null || t="$t-sujo"
  [[ -f web/.env.local ]] && token=$(grep -E '^VITE_MAPBOX_TOKEN=' web/.env.local | tail -n1 | cut -d= -f2- || true)
  [[ -n "$token" ]] || warn "Sem VITE_MAPBOX_TOKEN em web/.env.local: o mapa fica sem a imagem de satélite."
  # Endereço público da autoridade, para a página de verificação não depender da API: o do Secret Manager (deploy/gcp.sh
  # solana) ou o do cofre local, que se lê sem senha.
  local autoridade
  autoridade=$(g secrets versions access latest --secret nt-solana-autoridade 2>/dev/null || true)
  if [[ -z "$autoridade" && -f "$CHAVES_DIR/autoridade.json" ]]; then
    autoridade=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["endereco"])' "$CHAVES_DIR/autoridade.json")
  fi
  [[ -n "$autoridade" ]] || warn "Sem a autoridade da Solana: a página de verificação vai confiar na que a API informar."
  log "Construindo as imagens ($t)"
  g builds submit --config deploy/cloudbuild.yaml --service-account "projects/$PROJETO/serviceAccounts/$CONTA_BUILD" \
    --substitutions "_REPO=$REPO,_TAG=$t,_VITE_MAPBOX_TOKEN=$token,_VITE_NT_AUTORIDADE=$autoridade" .
  echo "$t" > deploy/.tag
}

# SEM_TRAFEGO=1: a revisão nova fica com 0% e a tag `candidata`; o tráfego continua na que está servindo.
servico() {
  TAG=$(tag)
  export TAG
  local existentes s
  existentes=$(g secrets list --filter 'name~nt-solana-' --format 'value(name.basename())')
  for s in "${SEGREDOS_SOLANA[@]}"; do
    grep -qx "$s" <<<"$existentes" || die "Falta o segredo $s da atestação: rode deploy/gcp.sh solana (README, \"Atestação na nuvem\")."
  done
  existe g storage buckets describe "gs://$BUCKET_IMAGENS" \
    || die "Falta o bucket gs://$BUCKET_IMAGENS das imagens históricas: rode deploy/gcp.sh infra."
  local m
  m=$(modo)
  if [[ "$m" == producao ]]; then
    # Só o balanceador (com o IAP) alcança o serviço, e a instância fica sempre ligada.
    export INGRESSO=internal-and-cloud-load-balancing MIN_INSTANCIAS=1
  else
    # URL run.app aberta na rede, mas só para quem tem papel no projeto (gcloud run services proxy); sem uso, desliga.
    export INGRESSO=all MIN_INSTANCIAS=0
  fi
  log "Publicando o serviço $SERVICO (imagens $TAG, modo $m)"
  local arquivo
  arquivo=$(temp_yaml)
  substituir_vars 'SERVICO REGIAO INGRESSO MIN_INSTANCIAS CONTA_SERVICO REPO TAG CONEXAO_SQL KMS_CHAVE SOLANA_RPC BUCKET_IMAGENS' \
    < deploy/service.yaml > "$arquivo"
  if [[ "${SEM_TRAFEGO:-}" == 1 ]]; then
    local atual
    # A revisão com todo o tráfego (com divisão ou sem nenhuma, não há o que preservar com segurança).
    atual=$(g run services describe "$SERVICO" --region "$REGIAO" --format json | python3 -c '
import json, sys
alvos = [t for t in json.load(sys.stdin).get("status", {}).get("traffic", []) if t.get("percent")]
print(alvos[0]["revisionName"] if len(alvos) == 1 and alvos[0]["percent"] == 100 else "")')
    [[ -n "$atual" ]] || die "Nenhuma revisão com 100% do tráfego: publique com deploy/gcp.sh teste ou ajuste o tráfego no Console."
    cat >> "$arquivo" <<YAML
  traffic:
    - revisionName: $atual
      percent: 100
    - latestRevision: true
      percent: 0
      tag: candidata
YAML
    log "A revisão nova sobe sem tráfego (continua em $atual)"
  fi
  g run services replace "$arquivo" --region "$REGIAO"
  rm -f "$arquivo"
  if [[ "$m" == producao ]]; then
    # Quem autentica é o IAP no balanceador; o ingresso do serviço já recusa quem não vem por ele.
    g run services add-iam-policy-binding "$SERVICO" --region "$REGIAO" --member allUsers --role roles/run.invoker >/dev/null
  else
    g run services remove-iam-policy-binding "$SERVICO" --region "$REGIAO" --member allUsers --role roles/run.invoker \
      >/dev/null 2>&1 || true
  fi
}

candidata() {
  [[ "$(modo)" == teste ]] || die "A candidata é aberta pelo run.app, que o modo de produção fecha: use o modo de teste."
  SEM_TRAFEGO=1 servico
  log "Para conferir: deploy/gcp.sh abrir candidata. Depois: deploy/gcp.sh promover"
}

promover() {
  local criada pronta
  criada=$(g run services describe "$SERVICO" --region "$REGIAO" --format 'value(status.latestCreatedRevisionName)')
  pronta=$(g run services describe "$SERVICO" --region "$REGIAO" --format 'value(status.latestReadyRevisionName)')
  [[ "$criada" == "$pronta" ]] \
    || die "A última revisão ($criada) não ficou pronta: o tráfego continua onde está. Veja os logs dela no Console."
  log "Todo o tráfego para $pronta"
  g run services update-traffic "$SERVICO" --region "$REGIAO" --to-latest --remove-tags candidata
}

teste() {
  echo teste > deploy/.modo
  servico
  # Sem as regras de encaminhamento o balanceador não cobra; IP, certificado e IAP ficam para o `producao`.
  log "Desligando o balanceador"
  existe g compute forwarding-rules describe nt-https --global && g compute forwarding-rules delete nt-https --global
  existe g compute forwarding-rules describe nt-http --global && g compute forwarding-rules delete nt-http --global
  log "Modo de teste. Para usar: deploy/gcp.sh abrir"
}

abrir() {
  log "NodalTrace${1:+ ($1)} em http://localhost:$PORTA_APP (Ctrl+C para fechar; a primeira página demora enquanto a instância sobe)"
  g run services proxy "$SERVICO" --region "$REGIAO" --port "$PORTA_APP" ${1:+--tag "$1"}
}

# O `gcloud run services proxy` lê o serviço (run.viewer) e o chama com a identidade da pessoa (run.invoker); os dois
# papéis só neste serviço, sem acesso ao resto do projeto.
testador() {
  [[ $# -eq 1 ]] || die "Uso: deploy/gcp.sh testador <e-mail>"
  local p
  for p in roles/run.viewer roles/run.invoker; do
    g run services add-iam-policy-binding "$SERVICO" --region "$REGIAO" --member "$(membro "$1")" --role "$p" >/dev/null
  done
  echo "Modo de teste liberado para $(membro "$1"). Ele precisa do gcloud logado com essa conta e de deploy/gcp.sh abrir."
}

remover-testador() {
  [[ $# -eq 1 ]] || die "Uso: deploy/gcp.sh remover-testador <e-mail>"
  local p
  for p in roles/run.viewer roles/run.invoker; do
    g run services remove-iam-policy-binding "$SERVICO" --region "$REGIAO" --member "$(membro "$1")" --role "$p" \
      >/dev/null 2>&1 || true
  done
  echo "Modo de teste retirado de $(membro "$1")."
}

producao() {
  echo producao > deploy/.modo
  servico
  lb
}

job() {
  local nome=$1; shift
  g run jobs deploy "$nome" --region "$REGIAO" --image "$REPO/pipeline:$(tag)" \
    --service-account "$CONTA_SERVICO" --set-cloudsql-instances "$CONEXAO_SQL" \
    --set-secrets DATABASE_URL=nt-database-url-socket:latest --max-retries 0 "$@"
}

# Lista de argumentos no formato do --args (separados por vírgula).
virgulas() { local IFS=,; echo "$*"; }

migrar() {
  sem_candidata
  log "Migrações (job nt-migrar)"
  job nt-migrar --args migrar --task-timeout 3600
  g run jobs execute nt-migrar --region "$REGIAO" --wait
  # O Martin só enxerga as funções de tile que existiam quando subiu: nova revisão.
  log "Nova revisão do serviço"
  g run services update "$SERVICO" --region "$REGIAO" --update-labels "migrado=$(date +%s)"
}

pipeline() {
  [[ $# -gt 0 ]] || die "Uso: deploy/gcp.sh pipeline <comando da pipeline> [args] (ex.: car --uf MT)"
  log "Pipeline: $* (job nt-pipeline, gs://$BUCKET em /dados)"
  job nt-pipeline --cpu 4 --memory 8Gi --task-timeout 86400 \
    --add-volume "name=dados,type=cloud-storage,bucket=$BUCKET,readonly=true" \
    --add-volume-mount "volume=dados,mount-path=/dados"
  g run jobs execute nt-pipeline --region "$REGIAO" --args "$(virgulas "$@")" --wait
}

# ---------- domínio e acesso ----------
# Tudo passa pelo IAP, menos a verificação pública dos relatórios (`/verificar` e `/verificar/<id>`): a página, os
# arquivos estáticos do frontend e GET /api/verificacao/<id>, que só lê (os dados do registro e onde conferir a conta na
# rede, nada dos imóveis). O resto da API continua atrás do login.
mapa_url() {
  local base="https://www.googleapis.com/compute/v1/projects/$PROJETO/global/backendServices"
  cat <<EOF
name: nt-mapa
defaultService: $base/nt-backend
hostRules:
  - hosts: ['*']
    pathMatcher: app
pathMatchers:
  - name: app
    defaultService: $base/nt-backend
    routeRules:
      - priority: 1
        description: Verificação pública dos relatórios, sem o IAP
        matchRules:
          - prefixMatch: /verificar
          - prefixMatch: /api/verificacao/
          - prefixMatch: /assets/
          - prefixMatch: /brand/
          - prefixMatch: /favicon
          - fullPathMatch: /apple-touch-icon.png
          - prefixMatch: /icon-
          - fullPathMatch: /site.webmanifest
        service: $base/nt-publico
EOF
}

lb() {
  log "Balanceador para https://$DOMINIO"
  existe g compute addresses describe nt-ip --global || g compute addresses create nt-ip --global --ip-version IPV4
  existe g compute network-endpoint-groups describe nt-neg --region "$REGIAO" \
    || g compute network-endpoint-groups create nt-neg --region "$REGIAO" --network-endpoint-type serverless \
         --cloud-run-service "$SERVICO"
  if ! existe g compute backend-services describe nt-backend --global; then
    g compute backend-services create nt-backend --global --load-balancing-scheme EXTERNAL_MANAGED
    g compute backend-services add-backend nt-backend --global --network-endpoint-group nt-neg \
      --network-endpoint-group-region "$REGIAO"
    # IAP ligado desde o início, com o cliente OAuth gerenciado pelo Google (só contas da organização): ninguém de
    # fora entra até `deploy/gcp.sh iap` trocar pelo cliente próprio e `acesso` liberar as pessoas.
    g compute backend-services update nt-backend --global --iap enabled
  fi
  # Mesmo serviço, sem o IAP: só a página pública de verificação da atestação e o que ela carrega (ver mapa_url).
  if ! existe g compute backend-services describe nt-publico --global; then
    g compute backend-services create nt-publico --global --load-balancing-scheme EXTERNAL_MANAGED
    g compute backend-services add-backend nt-publico --global --network-endpoint-group nt-neg \
      --network-endpoint-group-region "$REGIAO"
  fi
  local mapa
  mapa=$(temp_yaml)
  mapa_url > "$mapa"
  g compute url-maps import nt-mapa --global --source "$mapa"
  rm -f "$mapa"
  existe g compute ssl-certificates describe nt-cert --global \
    || g compute ssl-certificates create nt-cert --domains "$DOMINIO" --global
  existe g compute target-https-proxies describe nt-https --global \
    || g compute target-https-proxies create nt-https --url-map nt-mapa --ssl-certificates nt-cert --global
  existe g compute forwarding-rules describe nt-https --global \
    || g compute forwarding-rules create nt-https --global --load-balancing-scheme EXTERNAL_MANAGED \
         --address nt-ip --target-https-proxy nt-https --ports 443

  # http:// redireciona para https://.
  if ! existe g compute url-maps describe nt-redirecao --global; then
    local arquivo
    arquivo=$(temp_yaml)
    printf 'name: nt-redirecao\ndefaultUrlRedirect:\n  httpsRedirect: true\n  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT\n' > "$arquivo"
    g compute url-maps import nt-redirecao --global --source "$arquivo"
    rm -f "$arquivo"
  fi
  existe g compute target-http-proxies describe nt-http --global \
    || g compute target-http-proxies create nt-http --url-map nt-redirecao --global
  existe g compute forwarding-rules describe nt-http --global \
    || g compute forwarding-rules create nt-http --global --load-balancing-scheme EXTERNAL_MANAGED \
         --address nt-ip --target-http-proxy nt-http --ports 80

  local ip
  ip=$(g compute addresses describe nt-ip --global --format 'value(address)')
  log "No Cloudflare: registro A '${DOMINIO%%.*}' -> $ip, como 'DNS only' (nuvem cinza)."
  echo "O certificado fica ACTIVE de 15 a 60 min depois que o DNS apontar (deploy/gcp.sh status)."
}

iap() {
  [[ $# -eq 2 ]] || die "Uso: deploy/gcp.sh iap <client-id> <client-secret> (cliente OAuth do Console; ver README)"
  log "Ligando o IAP"
  g compute backend-services update nt-backend --global --iap "enabled,oauth2-client-id=$1,oauth2-client-secret=$2"
}

membro() { [[ "$1" == *:* ]] && echo "$1" || echo "user:$1"; }

acesso() {
  [[ $# -eq 1 ]] || die "Uso: deploy/gcp.sh acesso <e-mail | user:e-mail | domain:dominio>"
  g iap web add-iam-policy-binding --resource-type backend-services --service nt-backend \
    --member "$(membro "$1")" --role roles/iap.httpsResourceAccessor >/dev/null
  echo "Acesso liberado: $(membro "$1")"
}

remover() {
  [[ $# -eq 1 ]] || die "Uso: deploy/gcp.sh remover <membro>"
  g iap web remove-iam-policy-binding --resource-type backend-services --service nt-backend \
    --member "$(membro "$1")" --role roles/iap.httpsResourceAccessor >/dev/null
  echo "Acesso removido: $(membro "$1")"
}

acessos() {
  g iap web get-iam-policy --resource-type backend-services --service nt-backend \
    --format 'value(bindings.members)' | tr ';' '\n'
}

# ---------- atestação na Solana ----------
# Na nuvem não há quem digite a senha dos cofres a cada subida. Em vez de guardá-la, as chaves vão decifradas daqui
# (uma vez, com a senha digitada agora) direto para o Cloud KMS, que as cifra; o Secret Manager guarda só o texto
# cifrado, e só a conta do serviço (nt-run) pode decifrar, na subida da instância (deploy/kms-exec). A chave e a senha
# da autoridade nunca saem desta máquina: o setup do SAS continua no ./run.sh solana-setup.

kms_cifrar() {
  g kms encrypt --location "$REGIAO" --keyring "$KMS_ANEL" --key "$KMS_NOME" --plaintext-file - --ciphertext-file - \
    | base64 | tr -d '\n'
}

# Grava o stdin como versão nova do segredo (cria o segredo se faltar).
guardar() {
  if existe g secrets describe "$1"; then
    g secrets versions add "$1" --data-file - >/dev/null
  else
    g secrets create "$1" --replication-policy automatic --data-file - >/dev/null
  fi
}

# CLI do attestor num contêiner sem rede e sem log, com os cofres só leitura (o mesmo do ./run.sh).
cofres() {
  docker run --rm -i --network none --log-driver none --user "$(id -u):$(id -g)" -e NT_CHAVES_SENHA \
    -v "$CHAVES_DIR:/app/chaves:ro" --entrypoint node nodaltrace-attestor:local dist/cli.js "$@"
}

aleatorio() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

# Segredo HMAC entre API e attestor: criado se faltar; --trocar gera uma versão nova.
hmac_solana() {
  if [[ "${1:-}" == --trocar ]] || ! existe g secrets describe nt-solana-attestor-segredo; then
    aleatorio | kms_cifrar | guardar nt-solana-attestor-segredo
  fi
}

solana() {
  command -v docker >/dev/null || die "Docker não encontrado: os cofres são abertos aqui, num contêiner sem rede."
  [[ -t 0 ]] || die "Rode num terminal: a senha dos cofres é pedida sem eco."
  local c
  for c in atestador autoridade; do
    [[ -f "$CHAVES_DIR/$c.json" ]] || die "Falta $CHAVES_DIR/$c.json (CHAVES_DIR=<pasta> aponta os cofres do ./run.sh solana-chaves)."
  done

  log "Cloud KMS: chave $KMS_ANEL/$KMS_NOME, que só a conta do serviço usa para decifrar"
  g services enable cloudkms.googleapis.com
  existe g kms keyrings describe "$KMS_ANEL" --location "$REGIAO" || g kms keyrings create "$KMS_ANEL" --location "$REGIAO"
  existe g kms keys describe "$KMS_NOME" --keyring "$KMS_ANEL" --location "$REGIAO" \
    || g kms keys create "$KMS_NOME" --keyring "$KMS_ANEL" --location "$REGIAO" --purpose encryption
  g kms keys add-iam-policy-binding "$KMS_NOME" --keyring "$KMS_ANEL" --location "$REGIAO" \
    --member "serviceAccount:$CONTA_SERVICO" --role roles/cloudkms.cryptoKeyDecrypter >/dev/null

  log "Imagem do attestor (para abrir os cofres)"
  docker build -q -t nodaltrace-attestor:local attestor >/dev/null

  # Só a senha do atestador; a da autoridade nunca é pedida aqui.
  read -rsp "Senha do cofre do atestador: " NT_CHAVES_SENHA
  echo
  export NT_CHAVES_SENHA
  cofres conferir atestador || { unset NT_CHAVES_SENHA; die "Não consegui abrir o cofre atestador (senha errada?)."; }
  log "Cifrando o atestador com o KMS (o texto claro só passa por pipes, nesta máquina)"
  cofres revelar atestador | kms_cifrar | guardar nt-solana-atestador
  unset NT_CHAVES_SENHA

  # Público: vai em claro (a API e a página de verificação o usam).
  cofres endereco autoridade | tr -d '\n' | guardar nt-solana-autoridade
  hmac_solana
  log "Segredos da Solana prontos. Publique de novo (deploy/gcp.sh imagens e teste ou producao) para usá-los."
}

solana-rotacionar() {
  log "Segredo HMAC novo (API e attestor)"
  hmac_solana --trocar
  servico
}

solana-logs() {
  g logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICO\" AND
    (textPayload:\"attestor\" OR textPayload:\"kms-exec\")" \
    --freshness 1d --limit 40 --format 'value(timestamp,textPayload)'
}

# ---------- custo ----------
parar() {
  sem_candidata
  log "Desligando o Cloud SQL e a instância do serviço"
  g run services update "$SERVICO" --region "$REGIAO" --min-instances 0
  g sql instances patch "$INSTANCIA" --activation-policy NEVER
}

retomar() {
  log "Religando o Cloud SQL e a instância do serviço (alguns minutos)"
  g sql instances patch "$INSTANCIA" --activation-policy ALWAYS
  [[ "$(modo)" == producao ]] && g run services update "$SERVICO" --region "$REGIAO" --min-instances 1
  true
}

status() {
  g sql instances list --format 'table(name,databaseVersion,settings.tier,state,settings.activationPolicy)' || true
  g run services list --region "$REGIAO" --format 'table(metadata.name,status.url,status.latestReadyRevisionName)' || true
  g compute ssl-certificates list --format 'table(name,managed.domains,managed.status)' || true
  g compute addresses list --global --format 'table(name,address)' || true
}

case "${1:-help}" in
  infra|dump|importar|proxy|conferir|imagens|servico|candidata|promover|teste|producao|migrar|lb|acessos|parar|retomar|status) "$1" ;;
  solana|solana-rotacionar|solana-logs) "$1" ;;
  pipeline|iap|acesso|remover|testador|remover-testador|abrir) cmd=$1; shift; "$cmd" "$@" ;;
  -h|--help|help) sed -n '2,40p' "$0" ;;
  *) die "Comando desconhecido: $1 (use deploy/gcp.sh help)" ;;
esac
