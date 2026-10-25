import { describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, recoverTypedDataAddress, toHex, type Hex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, USDC } from "@overflow/schemas";
import { signTransfer } from "../authorization";
import { createChildDigest, delegationDomain, CREATE_CHILD_TYPES, recoverAuthorizationSigner, signCreateChild, signPauseChild, type ChildParams } from "../typed-data";
import { CdpSignerError, cdpSigner, wrapCdpAccount } from "./cdp";
import type { CdpAccountLike, CdpClientLike } from "./types";

// SIMULATED: a local key plays the CDP TEE. Never funded, never a real node key.
const REAL = privateKeyToAccount(keccak256(toHex("overflow.simulated.cdp-fake-account")));
const IMPOSTOR = privateKeyToAccount(keccak256(toHex("overflow.simulated.cdp-impostor")));
const TREASURY = "0x1111111111111111111111111111111111111111" as const;
const PAYEE = "0x2222222222222222222222222222222222222222" as const;

type SignFn = (td: TypedDataDefinition) => Promise<string>;

/** A fake CDP client whose account signs with `REAL` unless `sign` says otherwise. */
function fakeClient(opts: { sign?: SignFn; address?: string } = {}) {
  const account: CdpAccountLike = {
    address: opts.address ?? REAL.address,
    signTypedData: opts.sign ?? ((td) => REAL.signTypedData(td as Parameters<typeof REAL.signTypedData>[0])),
  };
  const getAccount = vi.fn(async (_: { name: string }) => account);
  const getOrCreateAccount = vi.fn(async (_: { name: string }) => account);
  const client: CdpClientLike = { evm: { getAccount, getOrCreateAccount } };
  return { client, getAccount, getOrCreateAccount, account };
}

const child: ChildParams = {
  parentId: "1",
  key: IMPOSTOR.address,
  cap: "10000000",
  maxPerCall: "1000000",
  expiry: "2000000000",
  restricted: false,
  payees: [],
  nonce: "0",
  deadline: "1999999999",
};

describe("cdpSigner", () => {
  it("signs a TransferWithAuthorization (USDC domain) that recovers to the CDP address", async () => {
    const { client, getAccount, getOrCreateAccount } = fakeClient();
    const resolved = await cdpSigner({ accountName: "overflow-node-test", client });
    expect(resolved).toMatchObject({ kind: "cdp", source: "cdp:overflow-node-test", address: REAL.address });
    expect(getAccount).toHaveBeenCalledWith({ name: "overflow-node-test" });
    expect(getOrCreateAccount).not.toHaveBeenCalled();

    const signed = await signTransfer({ nodeAccount: resolved.signer, treasury: TREASURY, to: PAYEE, value: 20000n, ttlSeconds: 60, nowSeconds: 1_900_000_000 });
    expect(signed.signer).toBe(REAL.address);
    expect(signed.typedData.domain).toMatchObject({ name: USDC.name, version: USDC.version, chainId: CHAIN_ID, verifyingContract: USDC.address });
    expect(await recoverAuthorizationSigner(signed.authorizationJson, signed.signature)).toBe(REAL.address);
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("signs CreateChild and PauseChild over the Overflow delegation domain", async () => {
    const { client } = fakeClient();
    const { signer } = await cdpSigner({ accountName: "overflow-node-test", client });
    const sig = await signCreateChild(signer, TREASURY, child);
    const recovered = await recoverTypedDataAddress({
      domain: delegationDomain(TREASURY),
      types: CREATE_CHILD_TYPES,
      primaryType: "CreateChild",
      message: { ...child, parentId: 1n, cap: 10000000n, maxPerCall: 1000000n, expiry: 2000000000n, nonce: 0n, deadline: 1999999999n, payeesHash: keccak256("0x") },
      signature: sig,
    });
    expect(recovered).toBe(REAL.address);
    expect(createChildDigest(TREASURY, child)).toMatch(/^0x[0-9a-f]{64}$/);
    const pause = await signPauseChild(signer, TREASURY, { target: "2", nonce: "0", deadline: "1999999999" });
    expect(pause).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("normalizes a v = 0/1 signature from the account to 27/28 and still recovers", async () => {
    const raws: string[] = [];
    const { client } = fakeClient({
      sign: async (td) => {
        const sig = await REAL.signTypedData(td as Parameters<typeof REAL.signTypedData>[0]);
        const v = Number.parseInt(sig.slice(-2), 16);
        return `${sig.slice(0, -2)}${(v - 27).toString(16).padStart(2, "0")}`;
      },
    });
    const { signer } = await cdpSigner({ accountName: "overflow-node-test", client, inspect: (raw) => raws.push(raw) });
    const signed = await signTransfer({ nodeAccount: signer, treasury: TREASURY, to: PAYEE, value: 1n, ttlSeconds: 60 });
    expect([27, 28]).toContain(Number.parseInt(signed.signature.slice(-2), 16));
    expect(raws).toHaveLength(1);
    expect([0, 1]).toContain(Number.parseInt(raws[0]!.slice(-2), 16));
  });

  it("rejects a 64-byte signature and a signature from another key", async () => {
    const short = fakeClient({ sign: async () => `0x${"ab".repeat(64)}` });
    const s1 = await cdpSigner({ accountName: "overflow-node-test", client: short.client });
    await expect(signTransfer({ nodeAccount: s1.signer, treasury: TREASURY, to: PAYEE, value: 1n, ttlSeconds: 60 })).rejects.toThrow(/64 bytes/);
    await expect(signTransfer({ nodeAccount: s1.signer, treasury: TREASURY, to: PAYEE, value: 1n, ttlSeconds: 60 })).rejects.toBeInstanceOf(CdpSignerError);

    const impostor = fakeClient({ sign: (td) => IMPOSTOR.signTypedData(td as Parameters<typeof IMPOSTOR.signTypedData>[0]) });
    const s2 = await cdpSigner({ accountName: "overflow-node-test", client: impostor.client });
    await expect(signCreateChild(s2.signer, TREASURY, child)).rejects.toThrow(/recovers to .* not the account/);
  });

  it("pins the address and names both sides on a mismatch", async () => {
    const { client } = fakeClient();
    await expect(cdpSigner({ accountName: "overflow-node-test", client, expectedAddress: IMPOSTOR.address })).rejects.toThrow(
      new RegExp(`${REAL.address}.*${IMPOSTOR.address}`),
    );
    const ok = await cdpSigner({ accountName: "overflow-node-test", client, expectedAddress: REAL.address.toLowerCase() as Hex });
    expect(ok.address).toBe(getAddress(REAL.address));
  });

  it("uses getOrCreateAccount only when create is set", async () => {
    const { client, getAccount, getOrCreateAccount } = fakeClient();
    await cdpSigner({ accountName: "overflow-node-test", client, create: true });
    expect(getOrCreateAccount).toHaveBeenCalledTimes(1);
    expect(getAccount).not.toHaveBeenCalled();
  });

  it("rejects invalid account names before touching the client and surfaces lookup failures by name only", async () => {
    const { client, getAccount } = fakeClient();
    await expect(cdpSigner({ accountName: "my_node", client })).rejects.toThrow(/alphanumerics or hyphens/);
    expect(getAccount).not.toHaveBeenCalled();
    const failing: CdpClientLike = {
      evm: {
        getAccount: async () => {
          throw new Error("404 not found\nsecret-looking second line");
        },
        getOrCreateAccount: async () => {
          throw new Error("unused");
        },
      },
    };
    const err = await cdpSigner({ accountName: "missing-node", client: failing }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpSignerError);
    expect((err as Error).message).toContain("cdp:missing-node");
    expect((err as Error).message).toContain("404 not found");
    expect((err as Error).message).not.toContain("second line");
  });

  it("wrapCdpAccount checksums the address", () => {
    const wrapped = wrapCdpAccount({ address: REAL.address.toLowerCase(), signTypedData: async () => "0x" }, "cdp:x");
    expect(wrapped.address).toBe(REAL.address);
  });
});
