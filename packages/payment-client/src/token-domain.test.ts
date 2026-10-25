import { describe, expect, it } from "vitest";
import { USDC } from "@overflow/schemas";
import { TokenDomainMismatchError, USDC_DOMAIN_ABI, verifyTokenDomain, type TokenDomainReader } from "./index";

type Facts = { name: unknown; version: unknown; decimals: unknown; DOMAIN_SEPARATOR: unknown };

function fakeClient(facts: Partial<Facts> = {}, chainId = 84532): TokenDomainReader & { calls: string[] } {
  const live: Facts = {
    name: "USDC",
    version: "2",
    decimals: 6,
    DOMAIN_SEPARATOR: USDC.domainSeparator,
    ...facts,
  };
  const calls: string[] = [];
  return {
    calls,
    async readContract({ address, abi, functionName }) {
      calls.push(`${address}:${functionName}`);
      expect(abi).toBe(USDC_DOMAIN_ABI);
      return live[functionName];
    },
    async getChainId() {
      return chainId;
    },
  };
}

async function mismatchFields(client: TokenDomainReader): Promise<string[]> {
  try {
    await verifyTokenDomain(client);
  } catch (e) {
    expect(e).toBeInstanceOf(TokenDomainMismatchError);
    return (e as TokenDomainMismatchError).mismatches.map((m) => m.field);
  }
  throw new Error("expected TokenDomainMismatchError");
}

describe("verifyTokenDomain", () => {
  it("passes for the pinned USDC facts and reads all four functions from the USDC address", async () => {
    const client = fakeClient();
    const v = await verifyTokenDomain(client);
    expect(v.domain).toEqual({ name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC.address });
    expect(v.decimals).toBe(6);
    expect(v.domainSeparator).toBe(USDC.domainSeparator);
    expect(client.calls.sort()).toEqual(
      ["name", "version", "decimals", "DOMAIN_SEPARATOR"].map((f) => `${USDC.address}:${f}`).sort(),
    );
  });

  it("works without getChainId on the client", async () => {
    const client = fakeClient();
    delete (client as Partial<TokenDomainReader>).getChainId;
    await expect(verifyTokenDomain(client)).resolves.toBeDefined();
  });

  it("names every mismatching field", async () => {
    expect(await mismatchFields(fakeClient({ name: "USD Coin" }))).toEqual(["name"]);
    expect(await mismatchFields(fakeClient({ version: "1" }))).toEqual(["version"]);
    expect(await mismatchFields(fakeClient({ decimals: 18 }))).toEqual(["decimals"]);
    expect(await mismatchFields(fakeClient({ DOMAIN_SEPARATOR: `0x${"00".repeat(32)}` }))).toEqual(["DOMAIN_SEPARATOR"]);
    expect(await mismatchFields(fakeClient({}, 8453))).toEqual(["chainId"]);
    expect(await mismatchFields(fakeClient({ name: "AUSD", version: "1", decimals: 18 }))).toEqual([
      "name",
      "version",
      "decimals",
    ]);
  });

  it("a different token address needs a different separator", async () => {
    const other = "0x9999999999999999999999999999999999999999" as const;
    const client = fakeClient();
    await expect(verifyTokenDomain(client, { token: other })).rejects.toBeInstanceOf(TokenDomainMismatchError);
  });
});
