# NodalTrace demo: how to use it

**Live demo:** https://nodaltrace-demo.up.railway.app

There's nothing to sign up for or install, and you don't need a crypto wallet: NodalTrace registers each report on
Solana from its own servers. A desktop browser gives the best view, but the demo also works on a phone.

**What the demo loads:** real public data for one state, Rio Grande do Sul (RS):

- every MapBiomas deforestation alert in RS;
- about 25% of the state's active CAR properties (167,852), sampled at random across the whole state.

Reports are registered on Solana devnet.

## The 5-minute path

**1. Open the link.** The map opens on Rio Grande do Sul, with the panel on the left. Under **Try these properties**,
the Home page lists five real properties, each one picked to show a different outcome:

| Example in the app | Expected result | What it shows |
| --- | --- | --- |
| Active CAR, no deforestation alerts | Compliant | The baseline: active in the registry, no alerts. |
| Deforestation after the EUDR cutoff | Non-compliant | A 37.7 ha alert from Oct 2025 fails both the EUDR and RenovaBio. |
| Passes the EUDR, fails RenovaBio | Non-compliant | An alert from Oct 2020 falls between the two cutoffs (Nov 2018 and Dec 2020), so the same land passes one regulation and fails the other. |
| Small alert after the cutoff: needs review | Attention | Overlaps under 1 ha go to a person for review instead of failing outright. |
| Alert next door, none on the property | Compliant | A 63 ha alert just outside the boundary doesn't count. Only overlap with the property matters. |

**2. Look at one property.** Click **Deforestation after the EUDR cutoff**. The map flies to the property, and the
panel shows its registry data and every alert that touches it. Open **Compare images**, then **Open comparison**: the
before and after images MapBiomas published for that alert appear side by side on the map, with a draggable divider.

**3. Run the analyses.** Go back to Home and click **Analyze all 5**. The five properties are now the selection;
click **Continue (5)**. All five available analyses come checked. (*IBAMA embargoes* is greyed out because that
dataset isn't loaded in the demo.) Click **Run 5 analyses**.

**4. Read the report.** The overall verdict is **Non-compliant**, with 2 Compliant, 1 Attention and 2 Non-compliant
properties. Each property card shows the result of every analysis, with the evidence behind it: alert IDs, areas and
dates. **Data sources** lists each dataset the report used, with the date its data runs through.

**5. Watch it reach Solana.** Within a few seconds, the **Solana registration** section changes to *Registered on
Solana (devnet)*. **Transaction** and **On-chain account** open the record in the Solana Explorer.

**6. Get the PDF.** Click **Download official report (PDF)**. Its QR code opens the verification page for that report.

**7. Verify it yourself.**

1. Click **Document (JSON)** to download the report file that was registered.
2. Open **Verification page** and drop the file on it. The page rebuilds the report's fingerprint (the Merkle root) in
   your browser and reads the record directly from Solana, without going through our servers. It answers *The
   document matches its Solana registration*.
3. Now try to cheat. Open the JSON in a text editor, change one `"nao_conforme"` to `"conforme"`, save, and drop it
   again. The page now says *The document does not match its registration*.

**8. Prove a single property.** On any property card in the report, **Proof for this property** downloads a file with
just that property. It passes on the verification page the same way, while the other four properties stay hidden.

## Try your own properties

- Zoom in to see property boundaries; they appear from zoom 8 on. Red patches are alerts after the EUDR cutoff. Grey
  ones came before it and don't count.
- On Home, clicking a property opens its details.
- To build a report, open **Analysis** in the left rail first. Then each click on the map adds a property or removes
  it. You can also paste a full CAR code in the search box. A report can hold up to 200 properties.
- Reports issued by other visitors are listed under **Issued reports** on Home, and you can open any of them.
- The top-right controls include **Compliance rules**, the exact thresholds every report applies.

## Glossary

### Brazil, data and regulations

- **CAR (Cadastro Ambiental Rural):** Brazil's mandatory public registry of rural properties. Owners declare each
  property's boundary and its native vegetation, and the government uses the registry to enforce the Forest Code. Each
  property on the map is one CAR registration.
- **CAR code:** the property's ID, for example `RS-4316907-09FEFD3B…`. It's made of the state, the municipality's IBGE
  code and a unique hash.
- **SICAR:** the federal system that hosts the CAR and publishes its data. NodalTrace loads that data directly.
- **Active CAR:** a registration in good standing. Pending, suspended and cancelled registrations also exist, but the
  demo loads only active ones.
- **SICAR condition:** the registry's own review status for the property, shown as published, in Portuguese.
- **Fiscal module:** a Brazilian unit of rural land size that varies by municipality, from 5 to 110 ha. A property of
  up to 4 modules is a small property under Brazilian law.
- **Hectare (ha):** 10,000 m², about 2.47 acres.
- **MapBiomas Alerta:** a Brazilian initiative that detects deforestation and publishes each alert after a person has
  validated it. Each alert comes with its outline, area, detection date, and before and after images.
- **IBGE:** Brazil's national statistics and geography institute. It's the source of the municipality and biome
  boundaries.
- **Biome:** one of Brazil's major ecological regions. Rio Grande do Sul has two, Pampa and Mata Atlântica (Atlantic
  Forest). In the report, the biome is informational for now.
- **RS (Rio Grande do Sul):** Brazil's southernmost state, and the only one loaded in this demo.
- **EUDR:** the EU Deforestation Regulation. In NodalTrace, this analysis checks for deforestation after the EUDR cutoff
  of **31 Dec 2020**.
- **RenovaBio:** Brazil's national biofuel program. Feedstock grown on land where native vegetation was cleared after
  **27 Nov 2018** doesn't qualify, and the property needs an active CAR.
- **Cutoff date:** the date after which deforestation counts against a property under a regulation. Alerts detected on
  or before it don't count.
- **IBAMA embargo:** an area that Brazil's federal environmental agency has embargoed for an environmental violation.
  This dataset isn't loaded in the demo.

### Results

- **Compliant:** passes.
- **Attention:** needs a person to review it, for example when an alert overlaps the property by less than 1 ha after
  the cutoff.
- **Non-compliant:** fails, for example when an alert overlaps the property by 1 ha or more after the cutoff.
- **Pending:** there isn't enough data to decide.
- **Informational:** shown for context, with no effect on the verdict.

A property takes the worst result among its analyses, and a report takes the worst result among its properties.

### Reports and blockchain

- **Report:** a permanent record of one analysis run, with an ID like `NT-2026-000001`. A report is never edited: a
  correction is a new report that points to the old one.
- **Document (JSON):** the machine-readable report, with exactly the content registered on Solana. The PDF is the
  human-readable version.
- **Merkle root:** a single fingerprint computed from the report's contents, one piece for the header plus one per
  property. Changing anything changes the root. Only the root goes on chain, never the farm data.
- **Partial proof:** a file with one property plus the hashes needed to reach the root. It lets a farmer prove their
  own result without revealing anyone else's.
- **Solana devnet:** Solana's public test network. Registrations there are real transactions, but devnet doesn't
  guarantee it will keep its history.
- **Solana Attestation Service:** the Solana program NodalTrace uses to register each report under its own credential,
  shown as *NODALTRACE credential* on the verification page.
