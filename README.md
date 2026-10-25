# NodalTrace (hackathon demo)

Deforestation compliance for rural properties in Brazil, with every report registered on Solana.

- **Live demo:** https://nodaltrace-demo.up.railway.app
- **How to try it:** [JUDGES_GUIDE.md](JUDGES_GUIDE.md), a 5-minute path and a glossary
- **Hackathon:** IEEE ClimateChain Global Hackathon 2026, track *Sustainable Supply Chains*

This repository is a snapshot of the code behind the public demo, published for judging. The demo loads one state, Rio
Grande do Sul; the product is built for all of Brazil. This page is the English entry point. Code comments and the full
technical documentation ([README.pt-BR.md](README.pt-BR.md), [DATA_DOCUMENTATION.md](DATA_DOCUMENTATION.md)) are in
Portuguese, the team's working language.

## What it does

NodalTrace puts every rural property from Brazil's official registry (the CAR) on a map, together with the public data
needed to judge it: MapBiomas deforestation alerts and IBGE biomes and municipalities. An analyst selects up to 200
properties, for example all the suppliers of a cooperative, and runs the analyses: deforestation after the EUDR cutoff,
RenovaBio eligibility and CAR status. Each property gets a result with its evidence. The report is immutable, comes with
an official PDF, and is registered on Solana as soon as it is issued.

## How the Solana part works

- **One fingerprint per report.** Each report becomes a Merkle tree, with leaves for the header, the summary and each
  property, in canonical JSON (JCS, RFC 8785). Only the root goes on chain, as an attestation in the Solana Attestation
  Service. No farm or client data is ever on chain.
- **One service holds the key.** Only the attestor (`attestor/`, TypeScript with Solana Kit) can sign. It loads its key
  from an encrypted vault, and the API reaches it only through HMAC-authenticated requests.
- **Anyone can verify.** The verification page (`web/src/verificar/`) rebuilds the root in the browser from the report
  file and reads the attestation directly from Solana, so it doesn't depend on our API. There's also a command-line
  verifier that talks to no NodalTrace server at all; its output is in Portuguese:

  ```bash
  pip install rfc8785
  python3 docs/atestacao/verificar.py relatorio-NT-2026-000001.json --autoridade 2B1bKsw9hg7BMF5BrUAEzeABB2a38ESKoNvzSUHaF5VF
  ```

- **Share only what you need.** A partial proof reveals a single property and still matches the registered root, so a
  farmer can share their own result and nothing else.
- **Corrections never edit.** A correction is a new report that points to the one it replaces, and both stay on record.
- **One shared spec.** The format is specified in [docs/atestacao/CONTRATO.md](docs/atestacao/CONTRATO.md). The test
  vectors in `docs/atestacao/vetores.json` are shared by the API, attestor and frontend test suites, so all three
  compute the same roots.

Public identities on Solana devnet:

| | Address |
| --- | --- |
| NodalTrace authority | `2B1bKsw9hg7BMF5BrUAEzeABB2a38ESKoNvzSUHaF5VF` |
| NODALTRACE credential | `4Vz1LpLi79ufM6McFm8Hv1JmsgyDXAe9RR1Cy1x8w83G` |
| Report schema | `FNM5eBAVgo6Fn6B8eFirWr6CkwvWF2bZn6A9qWPcdLCL` |
| Solana Attestation Service program | `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG` |

## Repository map

| Folder | What's in it |
| --- | --- |
| `pipeline/` | Python data pipeline: loads the CAR, MapBiomas Alerta and IBGE files into PostgreSQL/PostGIS. |
| `db/` | Database migrations, including the SQL that crosses every alert with every property and serves the map tiles. |
| `api/` | Python and FastAPI. All business rules (`api/nodaltrace/dominio/`, `api/nodaltrace/regras/`), reports and PDFs. |
| `web/` | React, TypeScript and MapLibre: the map, the analysis flow and the verification page. |
| `martin/` | Martin, which serves vector tiles straight from the database, so the browser loads only what's on screen. |
| `attestor/` | The signing service for Solana, tested against Surfpool (a local Solana network) before devnet. |
| `docs/atestacao/` | The attestation spec, the shared test vectors and the independent verifier. |
| `tests/` | A small sample of real data and the tests that check rules copied between the API and the database. |
| `deploy/` | Docker images, the Google Cloud production setup and, in `deploy/demo/`, everything specific to this demo. |
| `dados/` | Where the raw public datasets go. They aren't in Git; `dados/README.md` says where to download them. |

## What the demo changes

The demo branch differs from the product in a few places:

- **Data:** only Rio Grande do Sul, with every MapBiomas alert in the state and a random 25% of its active CAR properties
  (`deploy/demo/reduzir.sh`).
- **Map:** the rest of Brazil is masked, and property boundaries appear from zoom 8 on.
- **Language:** the screens, API texts and PDF are in English; the product is in Portuguese.
- **Imagery:** the historical INPE image comparison is turned off. MapBiomas alert images still work.
- **Hosting:** five services on Railway. The product runs on Google Cloud (Cloud Run and Cloud SQL, São Paulo region).

## Running it locally

You need Docker, Node 22.12+ and Python 3, plus the public datasets downloaded into `dados/` as described in
[dados/README.md](dados/README.md). Then run `./run.sh`: it checks the machine, starts everything, applies the
migrations, loads the data and opens the app. The full guide is in [README.pt-BR.md](README.pt-BR.md).

Tests: `./run.sh test` covers parity, the pipeline and the API on a test database built from `tests/dados/`, and
`cd web && npm test && npm run typecheck` covers the frontend. The same suites, including the attestor's, run in CI
(`.github/workflows/testes.yml`).

## License

No license is granted. Copyright © 2026 the NodalTrace team, all rights reserved. The code is published so the
hackathon judges can review it.
