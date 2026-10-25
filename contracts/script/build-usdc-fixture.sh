#!/usr/bin/env bash
# Builds the real USDC v2.2 test fixture from Circle's source.
#
# Clones circlefin/stablecoin-evm at a pinned commit, compiles FiatTokenV2_2,
# FiatTokenProxy and SignatureChecker with Circle's compiler settings
# (solc 0.6.12, optimizer runs 10000000), links FiatTokenV2_2's
# SignatureChecker placeholder to a fixed address, and writes creation
# bytecode hex files into contracts/test/fixtures/usdc-v2_2/.
#
# The fixtures are committed; teammates never need solc 0.6.12. Re-run this
# script only to regenerate them. Output is byte-identical across Linux and
# macOS because solc is deterministic for identical inputs and settings.
#
# Env overrides:
#   STABLECOIN_EVM_REF      git ref of circlefin/stablecoin-evm (default: pinned commit)
#   SOLC_VERSION            solc release tag without "v" (default 0.6.12)
#   OZ_VERSION              @openzeppelin/contracts npm version (default 3.4.2)
#   SIGNATURE_CHECKER_ADDR  address the SignatureChecker library is linked to
#   OUT_DIR                 where to write the fixtures (default: contracts/test/fixtures/usdc-v2_2)
set -euo pipefail

STABLECOIN_EVM_REPO="https://github.com/circlefin/stablecoin-evm"
STABLECOIN_EVM_REF="${STABLECOIN_EVM_REF:-fc85788bc7c23cefe3df1a757133048bfddadeaa}"
SOLC_VERSION="${SOLC_VERSION:-0.6.12}"
OZ_VERSION="${OZ_VERSION:-3.4.2}"
SIGNATURE_CHECKER_ADDR="${SIGNATURE_CHECKER_ADDR:-0x00000000000000000000000000000000005157c0}"
OPTIMIZER_RUNS=10000000

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${OUT_DIR:-$CONTRACTS_DIR/test/fixtures/usdc-v2_2}"

for tool in git curl jq npm tar; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required" >&2; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
log() { printf '==> %s\n' "$*" >&2; }

# 1. Circle source at the pinned commit.
log "cloning $STABLECOIN_EVM_REPO @ $STABLECOIN_EVM_REF"
git clone --quiet "$STABLECOIN_EVM_REPO" "$WORK/stablecoin-evm"
git -C "$WORK/stablecoin-evm" checkout --quiet "$STABLECOIN_EVM_REF"
CIRCLE_COMMIT="$(git -C "$WORK/stablecoin-evm" rev-parse HEAD)"

# 2. solc static binary from the ethereum/solidity GitHub release.
#    If the host cannot execute it (e.g. Apple Silicon without Rosetta: the release only ships
#    x86_64 binaries), fall back to the official solc-js build of the same version, which is the
#    same compiler built with Emscripten and produces identical bytecode for identical input.
case "$(uname -s)" in
  Linux)  SOLC_ASSET="solc-static-linux" ;;
  Darwin) SOLC_ASSET="solc-macos" ;;
  *) echo "error: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
SOLC_URL="https://github.com/ethereum/solidity/releases/download/v${SOLC_VERSION}/${SOLC_ASSET}"
log "downloading $SOLC_URL"
curl -fsSL "$SOLC_URL" -o "$WORK/solc"
chmod +x "$WORK/solc"
SOLC_MODE="native"
if SOLC_FULL_VERSION="$("$WORK/solc" --version 2>/dev/null | awk '/^Version:/ {print $2}')"; then
  :
else
  log "host cannot run $SOLC_ASSET ($(uname -sm)); falling back to solc-js (npm solc@$SOLC_VERSION)"
  SOLC_MODE="solc-js"
  ( cd "$WORK" && npm install --silent --no-audit --no-fund --prefix "$WORK/solcjs" "solc@$SOLC_VERSION" >/dev/null )
  SOLC_FULL_VERSION="$(node -e "console.log(require('$WORK/solcjs/node_modules/solc').version())")"
fi
case "$SOLC_FULL_VERSION" in
  "$SOLC_VERSION"*) ;;
  *) echo "error: expected solc $SOLC_VERSION, got '$SOLC_FULL_VERSION'" >&2; exit 1 ;;
esac
log "solc $SOLC_FULL_VERSION ($SOLC_MODE)"

# 3. OpenZeppelin Contracts via npm pack, placed where Circle's remapping expects it.
log "fetching @openzeppelin/contracts@$OZ_VERSION"
( cd "$WORK" && npm pack "@openzeppelin/contracts@$OZ_VERSION" --silent >/dev/null )
OZ_DIR="$WORK/stablecoin-evm/node_modules/@openzeppelin/contracts"
mkdir -p "$OZ_DIR"
tar -xzf "$WORK"/openzeppelin-contracts-*.tgz -C "$OZ_DIR" --strip-components=1

# 4. Compile, linking SignatureChecker at compile time. Both modes write $WORK/out.json in the
#    --combined-json shape: { contracts: { "path:Name": { abi, bin, "bin-runtime" } } }.
SC_FILE="contracts/util/SignatureChecker.sol"
V22_FILE="contracts/v2/FiatTokenV2_2.sol"
PROXY_FILE="contracts/v1/FiatTokenProxy.sol"
OZ_REMAPPING="@openzeppelin/contracts/=node_modules/@openzeppelin/contracts/"
log "compiling with --optimize --optimize-runs $OPTIMIZER_RUNS"
if [[ "$SOLC_MODE" == "native" ]]; then
  compile() {
    local libs="$1"
    ( cd "$WORK/stablecoin-evm" && "$WORK/solc" \
        --optimize --optimize-runs "$OPTIMIZER_RUNS" \
        --combined-json abi,bin,bin-runtime \
        --libraries "$libs" \
        "$OZ_REMAPPING" \
        "$V22_FILE" "$PROXY_FILE" "$SC_FILE" )
  }
  if ! compile "$SC_FILE:SignatureChecker:$SIGNATURE_CHECKER_ADDR" > "$WORK/out.json" 2> "$WORK/solc.err"; then
    log "fully qualified --libraries rejected by solc $SOLC_VERSION, retrying with the short form"
    compile "SignatureChecker:$SIGNATURE_CHECKER_ADDR" > "$WORK/out.json" 2> "$WORK/solc.err" \
      || { cat "$WORK/solc.err" >&2; exit 1; }
  fi
  grep -i 'error' "$WORK/solc.err" >&2 && exit 1 || true
else
  cat > "$WORK/compile.cjs" <<'JS'
// Standard-JSON compile with solc-js; mirrors the native CLI flags used above.
const fs = require("fs");
const path = require("path");
const [solcDir, repo, runs, libFile, libAddr, remapping, ...files] = process.argv.slice(2);
const solc = require(path.join(solcDir, "node_modules", "solc"));
const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");
const input = {
  language: "Solidity",
  sources: Object.fromEntries(files.map((f) => [f, { content: read(f) }])),
  settings: {
    optimizer: { enabled: true, runs: Number(runs) },
    remappings: [remapping],
    libraries: { [libFile]: { SignatureChecker: libAddr } },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};
const findImports = (p) => {
  try { return { contents: read(p) }; } catch (e) { return { error: `not found: ${p}` }; }
};
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) { for (const e of errors) console.error(e.formattedMessage); process.exit(1); }
const contracts = {};
for (const [file, byName] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(byName)) {
    contracts[`${file}:${name}`] = { abi: c.abi, bin: c.evm.bytecode.object, "bin-runtime": c.evm.deployedBytecode.object };
  }
}
process.stdout.write(JSON.stringify({ contracts, version: solc.version() }));
JS
  node "$WORK/compile.cjs" "$WORK/solcjs" "$WORK/stablecoin-evm" "$OPTIMIZER_RUNS" \
    "$SC_FILE" "$SIGNATURE_CHECKER_ADDR" "$OZ_REMAPPING" "$V22_FILE" "$PROXY_FILE" "$SC_FILE" \
    > "$WORK/out.json"
fi

bin_of() { jq -er --arg k "$1" '.contracts[$k].bin' "$WORK/out.json"; }
V22_BIN="$(bin_of "$V22_FILE:FiatTokenV2_2")"
PROXY_BIN="$(bin_of "$PROXY_FILE:FiatTokenProxy")"
SC_BIN="$(bin_of "$SC_FILE:SignatureChecker")"

if [[ "$V22_BIN" == *'__$'* ]]; then
  echo "error: FiatTokenV2_2 bytecode still contains a library placeholder" >&2; exit 1
fi
[[ "${#V22_BIN}" -gt 1000 && "${#PROXY_BIN}" -gt 1000 && "${#SC_BIN}" -gt 500 ]] \
  || { echo "error: unexpectedly small bytecode" >&2; exit 1; }

# 5. Write fixtures: 0x-prefixed creation bytecode, no trailing newline.
mkdir -p "$OUT_DIR"
printf '0x%s' "$V22_BIN"   > "$OUT_DIR/FiatTokenV2_2.linked.hex"
printf '0x%s' "$PROXY_BIN" > "$OUT_DIR/FiatTokenProxy.hex"
printf '0x%s' "$SC_BIN"    > "$OUT_DIR/SignatureChecker.hex"

# 6. README with provenance.
cat > "$OUT_DIR/README.md" <<README
# USDC v2.2 test fixture (Circle's compiled code, unmodified)

Creation bytecode for Circle's FiatToken, compiled from source so Foundry unit
tests run against the real USDC implementation offline. Loaded by
\`contracts/test/usdc/UsdcV22.sol\`. Test-only; nothing here is deployed.

| Item | Value |
| --- | --- |
| Source | ${STABLECOIN_EVM_REPO} |
| Commit | \`${CIRCLE_COMMIT}\` |
| License | Apache-2.0 (Circle Internet Group, Inc.) |
| Compiler | solc ${SOLC_FULL_VERSION}, built via ${SOLC_MODE} (native = release asset \`${SOLC_ASSET}\`; solc-js = npm \`solc@${SOLC_VERSION}\`, identical output) |
| Flags | \`--optimize --optimize-runs ${OPTIMIZER_RUNS} --combined-json abi,bin,bin-runtime\` |
| EVM version | solc ${SOLC_VERSION} default (istanbul) |
| OpenZeppelin | @openzeppelin/contracts@${OZ_VERSION} (npm), remapped to \`node_modules/@openzeppelin/contracts/\` |
| Library link | \`SignatureChecker\` -> \`${SIGNATURE_CHECKER_ADDR}\` (tests \`vm.etch\` its runtime there) |

| File | Contents | Hex length (chars, excl. 0x) |
| --- | --- | --- |
| \`FiatTokenV2_2.linked.hex\` | ${V22_FILE} creation code, SignatureChecker linked | ${#V22_BIN} |
| \`FiatTokenProxy.hex\` | ${PROXY_FILE} creation code (append \`abi.encode(implementation)\`) | ${#PROXY_BIN} |
| \`SignatureChecker.hex\` | ${SC_FILE} creation code | ${#SC_BIN} |

SHA-256 of the hex files at generation time:

\`\`\`
$(cd "$OUT_DIR" && if command -v shasum >/dev/null; then shasum -a 256 ./*.hex; else sha256sum ./*.hex; fi)
\`\`\`

Regenerate (needs git, curl, jq, npm, tar, node; downloads solc for the host OS):

    bash contracts/script/build-usdc-fixture.sh
README

log "wrote fixtures to $OUT_DIR"
if command -v shasum >/dev/null; then (cd "$OUT_DIR" && shasum -a 256 ./*.hex); else (cd "$OUT_DIR" && sha256sum ./*.hex); fi
