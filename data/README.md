# data/ — SIMULATED datasets and seller catalog

Everything in this folder is **SIMULATED**. The sellers, brands, registration counts and the "state registry feed" that signs the records are synthetic and redistributable (SPEC "What Recourse can't do": a revealed key decrypts the ciphertext for anyone holding it). No UI, agent or document may present these as real.

Regenerate (deterministic, byte-identical):

```sh
pnpm datasets:generate          # scripts/generate-datasets.mts -> data/
```

Generator source: `packages/datasets` (`@overflow/datasets`). The test `packages/datasets/src/catalog.test.ts` fails if regeneration changes a byte, if a listing stops validating against `ResourceListingSchema`, or if a listing's coverage metadata disagrees with the rows in its `records.bin`.

## Layout

```
catalog.json                                  CatalogFile (@overflow/datasets): 6 ResourceListing entries
datasets/<productId>/rows.csv                 header + rows, human-readable twin of records.bin
datasets/<productId>/records.bin              N x 160-byte signed records, same order as rows.csv
datasets/<productId>/manifest.json            DatasetManifest (@overflow/recourse-crypto)
```

| Dataset (`productId`) | Rows | Granularity | Period |
| --- | --- | --- | --- |
| `ev-registrations-national-monthly-2024-2026` | 528 | monthly | 2024-01 to 2026-09, 8 states, 2 brands |
| `ev-registrations-california-monthly-2024-2026` | 66 | monthly | 2024-01 to 2026-09, CA only (equals the national file's CA rows) |
| `ev-registrations-national-annual-2024-2026` | 48 | annual | 2024, 2025, 2026 year-to-date through September (exact sums of the monthly rows) |
| `ev-registrations-national-monthly-2021-2022` | 384 | monthly | 2021-01 to 2022-12 (the "wrong dates" listing) |

## Listings (catalog.json) and the rule each one exercises

| Listing id | Seller | Dataset | License / seats | Price | Exercises |
| --- | --- | --- | --- | --- | --- |
| `listing-national-monthly-2024-2026` | sim-seller-a | national monthly 2024-2026 | company-use / 10 | 12 USDC | Satisfies both Fusion example agents |
| `listing-california-monthly-2024-2026` | sim-seller-a | California monthly | company-use / 10 | 5 USDC | Geography: fails the national agent |
| `listing-national-annual-2024-2026` | sim-seller-a | national annual | company-use / 10 | 6 USDC | Resolution: annual cannot serve monthly |
| `listing-national-monthly-2021-2022` | sim-seller-a | national monthly 2021-2022 | company-use / 10 | 4 USDC | Dates: Oracle rejects it even though it is cheapest |
| `listing-national-monthly-2024-2026-seller-b` | sim-seller-b | national monthly 2024-2026 | company-use / 10 | 13 USDC | Duplicate from a second seller: same `manifestHash`, higher price |
| `listing-national-monthly-2024-2026-single-user` | sim-seller-a | national monthly 2024-2026 | single-user / 1 | 10 USDC | License: no merge |

Three listings share one `manifestHash` because they sell the same bytes; equal `manifestHash` is Fusion's "same product" signal. License and seats are listing terms, not content.

## Conventions

- **Regions** are ISO 3166-2 style codes. `US` is the national aggregate claim; `US-CA` etc. is state detail. A national listing lists `US` plus every state code present in its rows; the California listing lists only `US-CA`. Oracle's requirement extractor maps "California" / "United States" to these codes.
- **Rows** are `month,state,brand,units,simulated` (monthly) or `year,state,brand,units,simulated` (annual). `state` is the two-letter code, `brand` a fictional name (`Voltara`, `Kestrel`), `units` an integer, and the last column is always the literal `simulated` so a decrypted sample is self-describing. `coverage.fields` lists the first four columns.
- **Record timestamp** = first second (UTC) of the month after the period's last month, when a registry would publish it. A dataset's `minTimestamp` is its first record's timestamp (2024-02-01 for the 2024-2026 sets, 2021-02-01 for 2021-2022), so the stale set breaks a promise of `minTimestamp >= 2024-02-01`.
- **Dates** end at 2026-09-30 (`asOf` 2026-10-15) because today's feed cannot have October 2026. Requests must be clamped to the present before the coverage check.
- **Numbers** are a pure function of (state, period, brand): base volume x brand share x linear growth x seasonality, plus keccak-derived noise. Integer arithmetic only; no PRNG sequence, no floats.
- **Signer**: `SOURCE_SIGNER_KEY` from `.env` if set, else the label-derived simulated key `keccak256("overflow.simulated.source-signer")` (the same source signer as the recourse-crypto golden vectors), address `0x5a0C6b05F691791F272F84Dcff00fdCda52433Bd`. The committed files use the default; a custom key changes every signature and fails the determinism test until the regenerated files are committed.

## manifestHash

Fixed ABI fields, never JSON (`@overflow/recourse-crypto` `computeManifestHash`):

```
manifestHash = keccak256(abi.encode(bytes32 rootPlain, uint256 chunkCount, address sourceKey, uint64 minTimestamp, bytes32 headerHash))
headerHash   = keccak256(bytes(header))
```

`rootPlain` is the Merkle root of `keccak256(0x00 || chunk_i)` over the plaintext records and does not depend on the buyer, so one manifest serves every order; `rootCipher` and `keyCommitment` are per order and live in the escrow terms.
