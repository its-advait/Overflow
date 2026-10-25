import { describe, expect, it, vi } from "vitest";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { missingCdpCredentials, resolveNodeSigner } from "./resolve";
import type { CdpClientLike } from "./types";

// SIMULATED keys, never funded.
const KEY = keccak256(toHex("overflow.simulated.resolve-env-key"));
const ENV_ACCOUNT = privateKeyToAccount(KEY);
const CDP_ACCOUNT = privateKeyToAccount(keccak256(toHex("overflow.simulated.resolve-cdp-account")));

const CREDS = { CDP_API_KEY_ID: "id-not-a-real-value", CDP_API_KEY_SECRET: "secret-not-a-real-value", CDP_WALLET_SECRET: "wallet-not-a-real-value" };

function fakeCdp(): CdpClientLike {
  const account = { address: CDP_ACCOUNT.address, signTypedData: (td: unknown) => CDP_ACCOUNT.signTypedData(td as Parameters<typeof CDP_ACCOUNT.signTypedData>[0]) };
  return { evm: { getAccount: async () => account, getOrCreateAccount: async () => account } };
}

describe("resolveNodeSigner", () => {
  it("defaults to the env key and never loads a CDP client", async () => {
    const cdp = vi.fn(fakeCdp);
    const r = await resolveNodeSigner({ NODE_PRIVATE_KEY: KEY }, { cdp });
    expect(r).toMatchObject({ kind: "env-key", address: ENV_ACCOUNT.address, source: "NODE_PRIVATE_KEY (env)" });
    expect(cdp).not.toHaveBeenCalled();
  });

  it("treats empty strings as unset and rejects an unknown mode", async () => {
    await expect(resolveNodeSigner({ NODE_SIGNER: "", NODE_PRIVATE_KEY: KEY })).resolves.toMatchObject({ kind: "env-key" });
    await expect(resolveNodeSigner({ NODE_SIGNER: "vault", NODE_PRIVATE_KEY: KEY })).rejects.toThrow(/NODE_SIGNER must be "env" or "cdp"/);
    await expect(resolveNodeSigner({ NODE_PRIVATE_KEY: "0x1234" })).rejects.toThrow(/NODE_PRIVATE_KEY must be a 0x 64-hex key/);
  });

  it("honours the label prefix", async () => {
    const r = await resolveNodeSigner({ AGENT_ROOT_PRIVATE_KEY: KEY }, { label: "AGENT_ROOT" });
    expect(r.source).toBe("AGENT_ROOT_PRIVATE_KEY (env)");
    await expect(resolveNodeSigner({}, { label: "AGENT_ROOT" })).rejects.toThrow(/AGENT_ROOT_ACCOUNT/);
  });

  it("cdp mode names the missing credential without echoing any value", async () => {
    const env = { NODE_SIGNER: "cdp", CDP_API_KEY_ID: CREDS.CDP_API_KEY_ID, CDP_API_KEY_SECRET: CREDS.CDP_API_KEY_SECRET, CDP_ACCOUNT_NAME: "overflow-node-root" };
    const cdp = vi.fn(fakeCdp);
    const err = await resolveNodeSigner(env, { cdp }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("CDP_WALLET_SECRET");
    expect((err as Error).message).not.toContain("CDP_API_KEY_SECRET");
    for (const v of Object.values(CREDS)) expect((err as Error).message).not.toContain(v);
    expect(cdp).not.toHaveBeenCalled();
    expect(missingCdpCredentials(env)).toEqual(["CDP_WALLET_SECRET"]);
    expect(missingCdpCredentials({ CDP_API_KEY_NAME: "x", CDP_API_KEY_SECRET: "y", CDP_WALLET_SECRET: "z" })).toEqual([]);
  });

  it("cdp mode validates the account name before any client call", async () => {
    const cdp = vi.fn(fakeCdp);
    await expect(resolveNodeSigner({ NODE_SIGNER: "cdp", ...CREDS }, { cdp })).rejects.toThrow(/CDP_ACCOUNT_NAME/);
    await expect(resolveNodeSigner({ NODE_SIGNER: "cdp", ...CREDS, CDP_ACCOUNT_NAME: "my_node" }, { cdp })).rejects.toThrow(/CDP_ACCOUNT_NAME: .*hyphens/);
    expect(cdp).not.toHaveBeenCalled();
  });

  it("cdp mode returns the CDP account and honours the address pin", async () => {
    const r = await resolveNodeSigner({ NODE_SIGNER: "cdp", ...CREDS, CDP_ACCOUNT_NAME: "overflow-node-root", NODE_PRIVATE_KEY: KEY }, { cdp: fakeCdp });
    expect(r).toMatchObject({ kind: "cdp", source: "cdp:overflow-node-root", address: CDP_ACCOUNT.address });
    await expect(
      resolveNodeSigner({ NODE_SIGNER: "cdp", ...CREDS, CDP_ACCOUNT_NAME: "overflow-node-root", CDP_ACCOUNT_ADDRESS: ENV_ACCOUNT.address }, { cdp: fakeCdp }),
    ).rejects.toThrow(/CDP_ACCOUNT_ADDRESS pins/);
  });
});
