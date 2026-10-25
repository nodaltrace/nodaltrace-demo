# dados/

Pasta dos **arquivos brutos das bases reais** (CAR do SICAR, MapBiomas Alerta, biomas do IBGE) que a pipeline carrega no
banco. **Nada daqui vai para o Git** (ver `.gitignore`): só este README é versionado. Num clone novo, esta pasta vem
vazia, e é você quem a preenche.

Referência completa dos dados (tabelas, fluxos, nuvem): [`DATA_DOCUMENTATION.md`](../DATA_DOCUMENTATION.md), em
especial a seção 0. Os pontos frágeis da carga, com onde estão no código, estão na seção 22.2.

## Como o dado sai daqui e chega ao app

```
dados/ (arquivos baixados)  ──►  pipeline (contêiner)  ──►  banco PostGIS (volume Docker pgdata)  ──►  API e mapa
                                 lê a pasta montada         guarda tudo, de forma permanente
                                 em /dados
```

- A pasta é **montada** em `/dados` no contêiner da pipeline (`DADOS_DIR` no `.env`, padrão `./dados`). Ela **não é
  copiada** para nenhuma imagem Docker.
- A pipeline lê os arquivos e grava no banco. **O banco fica no disco do Docker, não na pasta do repositório**: por
  isso a pasta do projeto ocupa centenas de MB enquanto o banco ocupa GBs. No Mac e no Windows, o disco do Docker é um
  arquivo só da máquina virtual do Docker Desktop.
- **Carrega-se uma vez.** Depois da carga, os arquivos daqui podem ser apagados ou movidos: o banco continua com tudo.
  Você só precisa deles de novo para carregar outro estado, atualizar uma base, ou depois de apagar o banco
  (`./run.sh reset`, `./run.sh limpar`, ou o "Clean / Purge data" e o "Reset to factory defaults" do Docker Desktop).
- **Deixar os arquivos aqui deixa o `./run.sh` mais lento**: a cada execução ele importa o CAR de novo (minutos por
  estado), sem criar versões novas. MapBiomas e biomas reconhecem o mesmo arquivo pelo hash e não fazem nada. No dia a
  dia, use `./run.sh infra` e `./run.sh web`, que não carregam nada.
- O app local **não busca nada do Google Cloud**: o banco local tem só o que foi carregado a partir desta pasta. Ele
  não é sincronizado com o banco da nuvem.

## O que cada parte do app precisa

| Parte do app | Arquivos necessários |
|---|---|
| Mapa, busca e detalhe dos imóveis | CAR das UFs que interessam (`AREA_IMOVEL/<UF>/`) |
| Alertas no mapa, critério EUDR do imóvel e as análises de desmatamento e RenovaBio | **MapBiomas Alerta** |
| Bioma no mapa, no detalhe e na análise de bioma | biomas do IBGE |

Sem nenhum arquivo o app sobe, com o mapa vazio de imóveis. Os municípios do IBGE não precisam de arquivo: a carga do
CAR os baixa da API do IBGE (precisa de internet).

## De onde tirar os arquivos

| Origem | Como |
|---|---|
| **Drive do Google da equipe** | as bases que a equipe usa. **URL: a preencher.** Ao copiar, confira a estrutura abaixo: cópias antigas podem ter o CAR direto em `AREA_IMOVEL/`, sem a pasta da UF |
| Bucket da nuvem `gs://<projeto-gcp>-dados/` | o mesmo layout desta pasta, com acesso ao projeto: `gcloud storage ls gs://<projeto-gcp>-dados/` e, por exemplo, `gcloud storage cp -r gs://<projeto-gcp>-dados/AREA_IMOVEL/RS dados/AREA_IMOVEL/` |
| SICAR | consulta pública, download por estado, tema "Área do Imóvel" |
| MapBiomas Alerta | o shapefile de alertas validados com geometria (`alerts_with_intersections`) |
| IBGE | [biomas 1:250.000](https://geoftp.ibge.gov.br/informacoes_ambientais/estudos_ambientais/biomas/vetores/): `2025_Biomas-e-Sistema-Costeiro-Marinho-do-Brasil-1-250000_shp.zip`, descompactado em `BIOMAS/` |

## Estrutura esperada

**Nomes e pastas têm de ser exatamente estes.** Um arquivo no lugar errado não dá erro: o `./run.sh` só avisa "Pulando…"
e segue sem ele.

```
dados/
├── AREA_IMOVEL/                         # SICAR, tema "Área do Imóvel": UMA PASTA POR ESTADO
│   ├── RS/
│   │   └── AREA_IMOVEL_1.shp (+ .shx .dbf .prj)
│   ├── MG/                              # estado dividido pelo SICAR: todas as partes, numa carga só
│   │   ├── AREA_IMOVEL_1.shp (+ …)
│   │   └── AREA_IMOVEL_2.shp (+ …)
│   ├── PA/                              # ou os .zip do SICAR como vieram, sem descompactar
│   │   └── AREA_IMOVEL_1.zip
│   └── <UF>/ …
├── alerts_with_intersections/           # MapBiomas Alerta: alertas com geometria
│   └── alerts_with_intersections.shp (+ .shx .dbf .prj .cpg)
└── BIOMAS/                              # IBGE, Biomas e Sistema Costeiro-Marinho do Brasil 1:250.000 (edição 2025)
    └── lml_bioma_e250k_v20250911_A.shp (+ .shx .dbf .prj .cpg; o zip traz também o estilo de cores Bioma_n1_2025.qml)
```

| Pasta | Comando que usa | Regras |
|---|---|---|
| `AREA_IMOVEL/<UF>/` | `car` (todos os estados, ou os de `--uf`) | a pasta tem o nome da sigla (RS, MT…); `.shp`, `.gpkg` ou os `.zip` do SICAR fechados (com os dois, valem os descompactados); as partes entram em ordem numérica. **Arquivo direto em `AREA_IMOVEL/`, sem a pasta da UF, é ignorado** (versões antigas da pipeline aceitavam) |
| `alerts_with_intersections/` | `mapbiomas` | o `.shp` descompactado; só as colunas `ALERTCODE`, `ALERTHA`, `SOURCE`, `DETECTAT`, `ALERTCLASS` são lidas. Um `car_with_alerts_and_intersections` que venha junto não é mais usado: o cruzamento com o CAR é calculado pela pipeline |
| `BIOMAS/` | `biomas` | o `.shp` descompactado |

Cada shapefile precisa dos arquivos irmãos com o mesmo nome (`.shp`, `.shx`, `.dbf`, `.prj`, e `.cpg` quando houver). Os
zips do MapBiomas trazem uma pasta `__MACOSX/` que pode ser descartada.

Com outro nome de arquivo, diga onde ele está (caminho de dentro do contêiner, começando em `/dados`):

```bash
ALERTAS_ARQUIVO=/dados/meu_mapbiomas/alertas.shp BIOMAS_ARQUIVO=/dados/biomas/biomas.shp ./run.sh dados
```

## Como carregar

```bash
./run.sh                 # primeira vez: confere a máquina, sobe tudo e carrega o que houver aqui
./run.sh dados           # só a carga (CAR de todas as UFs com pasta + MapBiomas + biomas), com o banco no ar
UFS="RS SC" ./run.sh dados          # só alguns estados do CAR
./run.sh diagnostico     # o que há aqui para carregar e, com o banco no ar, o que já está carregado
```

A ordem não importa: a carga do CAR cruza os imóveis com o MapBiomas já carregado, e a do MapBiomas cruza com o CAR já
carregado.

Para conferir o resultado: `./run.sh diagnostico`, ou `http://localhost:8000/saude` (o CAR por UF) e
`http://localhost:8000/analises/camadas` (a camada do MapBiomas).

## Vários estados

Um comando carrega todos os estados com pasta, vários ao mesmo tempo, com os municípios do IBGE que faltarem; os estados
já carregados só gravam o que mudou:

```bash
docker compose run --rm pipeline car                                    # todos (o mesmo que ./run.sh dados faz)
docker compose run --rm pipeline car --uf MT GO                         # só alguns
docker compose run --rm pipeline car --publicado-em 2026-10-01          # com a data de publicação no SICAR
docker compose run --rm pipeline ufs-car                                # lista os estados encontrados
```

A data de cada carga sai do próprio arquivo (a atualização mais recente de um imóvel); `--publicado-em` registra
também a data de publicação no SICAR, quando se sabe (ver README.pt-BR.md, "Pipeline", "Datas das cargas"). Um arquivo com
dados mais antigos que a última carga do estado é recusado. `--paralelo` (padrão 4) diz quantos estados carregam ao
mesmo tempo. Um estado que falha não interrompe os outros: o
comando termina com a lista dos que falharam.

O MapBiomas Alerta e os biomas já são nacionais.

## Num disco externo

Deixe os arquivos onde estão e aponte `DADOS_DIR` no `.env` para a pasta (com aspas se tiver espaço no nome):

```bash
DADOS_DIR="/Volumes/Meu Disco/nodaltrace-dados"   # Mac
DADOS_DIR=/media/usuario/disco/nodaltrace-dados    # Linux
DADOS_DIR=/mnt/d/nodaltrace-dados                   # Windows (WSL)
```

Com o disco desconectado, o `./run.sh` avisa e pula a carga. O disco só precisa estar conectado durante a carga.

## Na nuvem

O equivalente desta pasta é o bucket `gs://<projeto-gcp>-dados/`, com a mesma estrutura, montado em
`/dados` (somente leitura) pelo job da pipeline (`deploy/gcp.sh pipeline <comando>`; ver "Nuvem (Google Cloud)" no README).
Envie só o que for carregar, por exemplo `gcloud storage cp -r dados/AREA_IMOVEL/MT
gs://<projeto-gcp>-dados/AREA_IMOVEL/`. O banco da nuvem não é alimentado por esta pasta local: ele veio
de uma cópia de um banco local (`deploy/gcp.sh dump` + `importar`) e recebe cargas pelos jobs.

## Problemas comuns

| Sintoma | Causa e solução |
|---|---|
| "Pulando CAR: nenhum estado em …/AREA_IMOVEL/<UF>/" | o CAR não está numa pasta por estado: crie `AREA_IMOVEL/RS/` (a sigla certa) e mova os arquivos para ela |
| "Arquivo não encontrado: /dados/alerts_with_intersections/…" ou "…/BIOMAS/…" | nome ou pasta diferente: renomeie, ou use `ALERTAS_ARQUIVO`/`BIOMAS_ARQUIVO` |
| "Pasta das bases não encontrada" | `DADOS_DIR` aponta para um lugar que não existe (disco externo desconectado?) |
| O mapa não mostra alertas e a análise de desmatamento aparece indisponível | falta o MapBiomas no banco: coloque o arquivo e rode `./run.sh dados` |
| A carga do CAR avisa "municípios do IBGE não carregados" | sem internet na hora: `docker compose run --rm pipeline municipios --uf RS` depois |
| `ogr2ogr` falha num estado | shapefile incompleto (faltam `.shx`, `.dbf` ou `.prj`) ou arquivo corrompido: baixe de novo |
| O banco sumiu depois de mexer no Docker Desktop | "Clean / Purge data" ou "Reset to factory defaults" apagam os volumes: carregue de novo a partir desta pasta |
