# USDC v2.2 test fixture (Circle's compiled code, unmodified)

Creation bytecode for Circle's FiatToken, compiled from source so Foundry unit
tests run against the real USDC implementation offline. Loaded by
`contracts/test/usdc/UsdcV22.sol`. Test-only; nothing here is deployed.

| Item | Value |
| --- | --- |
| Source | https://github.com/circlefin/stablecoin-evm |
| Commit | `fc85788bc7c23cefe3df1a757133048bfddadeaa` |
| License | Apache-2.0 (Circle Internet Group, Inc.) |
| Compiler | solc 0.6.12+commit.27d51765.Emscripten.clang, built via solc-js (native = release asset `solc-macos`; solc-js = npm `solc@0.6.12`, identical output) |
| Flags | `--optimize --optimize-runs 10000000 --combined-json abi,bin,bin-runtime` |
| EVM version | solc 0.6.12 default (istanbul) |
| OpenZeppelin | @openzeppelin/contracts@3.4.2 (npm), remapped to `node_modules/@openzeppelin/contracts/` |
| Library link | `SignatureChecker` -> `0x00000000000000000000000000000000005157c0` (tests `vm.etch` its runtime there) |

| File | Contents | Hex length (chars, excl. 0x) |
| --- | --- | --- |
| `FiatTokenV2_2.linked.hex` | contracts/v2/FiatTokenV2_2.sol creation code, SignatureChecker linked | 47134 |
| `FiatTokenProxy.hex` | contracts/v1/FiatTokenProxy.sol creation code (append `abi.encode(implementation)`) | 4218 |
| `SignatureChecker.hex` | contracts/util/SignatureChecker.sol creation code | 3558 |

SHA-256 of the hex files at generation time:

```
d080d29b2211357499606e2c61183413999f74226eb09fecbc1c1d85ad6b155d  ./FiatTokenProxy.hex
7d14121fd4643f689b5ab393c3274d4a21d4c404c947050e489ded8eeef95882  ./FiatTokenV2_2.linked.hex
c8c67ecad6f54e9b49789047a25bed6b589126de7acf86be8090eef466eab229  ./SignatureChecker.hex
```

Regenerate (needs git, curl, jq, npm, tar, node; downloads solc for the host OS):

    bash contracts/script/build-usdc-fixture.sh
