import { USDC, type EscrowChainState, type EscrowOrder } from "@overflow/schemas";
import { Address, Mono } from "@/components/shared/address";
import { Money } from "@/components/shared/money";
import { Field } from "@/components/shared/panel";
import { Pill } from "@/components/shared/status-pill";
import { revealedKeyMatches } from "@/lib/escrow/evidence";
import { challengeEndOf, formatUnix } from "@/lib/escrow/state";

/** OrderTerms as stored by the indexer, beside what the chain reports right now. Every hash is shown in full. */
export function TermsTable({ escrow, chain, chainUnavailable }: { escrow: EscrowOrder; chain: EscrowChainState | null; chainUnavailable?: string | undefined }) {
  const revealed = chain?.revealedKey && !/^0x0+$/.test(chain.revealedKey) ? chain.revealedKey : escrow.revealedKey;
  const keyOk = revealedKeyMatches(revealed, escrow.keyCommitment);
  const challengeEnd = challengeEndOf(escrow, chain);
  return (
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="Seller">
        <Address value={escrow.sellerAddress} chars={6} />
      </Field>
      <Field label="Token">
        <span className="flex items-center gap-2">
          <Address value={USDC.address} chars={6} />
          <span className="text-xs text-text-muted">USDC, 6 decimals</span>
        </span>
      </Field>
      <Field label="Escrow">
        <Address value={escrow.escrowAddress} chars={6} />
      </Field>
      <Field label="Amount (price)">
        <Money atomic={escrow.amountAtomic} />
      </Field>
      <Field label="Seller bond">
        <Money atomic={escrow.bondAtomic} />
      </Field>
      <Field label="Held by the escrow now">
        {chain ? (
          <span className="flex items-center gap-2">
            <Money atomic={chain.balanceAtomic} />
            <span className="text-xs text-text-muted">at block {chain.blockNumber}</span>
          </span>
        ) : (
          <span className="text-xs text-warning">chain not read{chainUnavailable ? `: ${chainUnavailable}` : ""}</span>
        )}
      </Field>
      <Field label="Terms hash">
        <Mono value={escrow.termsHash} />
      </Field>
      <Field label="Manifest hash">
        <Mono value={escrow.manifestHash} />
      </Field>
      <Field label="Order id">
        <Mono value={escrow.orderIdBytes32} />
      </Field>
      <Field label="rootPlain (plaintext leaves)">
        <Mono value={escrow.rootPlain} />
      </Field>
      <Field label="rootCipher (ciphertext chunks)">
        <Mono value={escrow.rootCipher} />
      </Field>
      <Field label="Key commitment keccak256(k)">
        <Mono value={escrow.keyCommitment} />
      </Field>
      <Field label="Revealed key k">
        {revealed ? (
          <span className="flex flex-wrap items-center gap-2">
            <Mono value={revealed} />
            <span data-testid="key-matches" data-ok={keyOk} className="contents">
              <Pill tone={keyOk ? "success" : "danger"} title="keccak256(abi.encodePacked(k)) compared with the terms' keyCommitment in this browser">
                {keyOk ? "matches commitment" : "does not match commitment"}
              </Pill>
            </span>
          </span>
        ) : (
          <span className="text-xs text-text-muted">not revealed</span>
        )}
      </Field>
      <Field label="Chunks (160-byte records)">{escrow.chunkCount}</Field>
      <Field label="Source key (record signer)">
        <Address value={escrow.sourceKey} chars={6} />
      </Field>
      <Field label="Minimum record timestamp">
        {formatUnix(escrow.minTimestamp)} <span className="text-xs text-text-muted">({escrow.minTimestamp})</span>
      </Field>
      <Field label="Reveal deadline">
        {formatUnix(escrow.revealDeadline)} <span className="text-xs text-text-muted">({escrow.revealDeadline})</span>
      </Field>
      <Field label="Challenge window">{escrow.challengeWindow} s after the reveal</Field>
      <Field label="Challenge end">
        {challengeEnd > 0n ? (
          <>
            {formatUnix(challengeEnd)} <span className="text-xs text-text-muted">({challengeEnd.toString()})</span>
          </>
        ) : (
          <span className="text-xs text-text-muted">set by KeyRevealed</span>
        )}
      </Field>
      <Field label="Chain read">
        {chain ? (
          <span className="text-xs text-text-muted">
            block {chain.blockNumber} · {formatUnix(chain.blockTimestamp)} · status {chain.status}
          </span>
        ) : (
          <span className="text-xs text-text-muted">stored status {escrow.status} (updated {escrow.updatedAt.slice(0, 16).replace("T", " ")} UTC)</span>
        )}
      </Field>
    </dl>
  );
}
