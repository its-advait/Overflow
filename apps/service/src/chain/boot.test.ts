import { describe, expect, it } from "vitest";
import { USDC } from "@overflow/schemas";
import { BootCheckFailed, verifyBoot } from "./boot";
import { deployments, fakeChain } from "../facilitator/fakes.test-util";

function tokenReads(over: Record<string, unknown> = {}) {
  return { name: "USDC", version: "2", decimals: 6, DOMAIN_SEPARATOR: USDC.domainSeparator, TOKEN: USDC.address, escrowFactory: "0x0000000000000000000000000000000000000000", ...over };
}

describe("verifyBoot", () => {
  it("passes for a consistent deployment", async () => {
    const chain = fakeChain();
    chain.reads = tokenReads();
    const r = await verifyBoot(chain, deployments);
    expect(r).toMatchObject({ chainId: 84532, treasury: deployments.treasury, blockNumber: 100n });
    expect(r.token.domainSeparator).toBe(USDC.domainSeparator);
  });
  it.each([
    ["wrong chain", (c: ReturnType<typeof fakeChain>) => { c.getChainId = async () => 8453; }, /chain 8453/],
    ["wrong token domain", (c: ReturnType<typeof fakeChain>) => { c.reads = tokenReads({ version: "1" }); }, /version/],
    ["no treasury code", (c: ReturnType<typeof fakeChain>) => { c.reads = tokenReads(); c.getCode = async () => "0x"; }, /no contract code/],
    ["treasury TOKEN mismatch", (c: ReturnType<typeof fakeChain>) => { c.reads = tokenReads({ TOKEN: "0x1111111111111111111111111111111111111111" }); }, /TOKEN\(\)/],
  ])("fails loudly: %s", async (_l, mutate, re) => {
    const chain = fakeChain();
    mutate(chain);
    await expect(verifyBoot(chain, deployments)).rejects.toSatisfy((e: unknown) => e instanceof BootCheckFailed && re.test(e.message));
  });
  it("fails when the deployments token is not USDC or the factory is not wired", async () => {
    const chain = fakeChain();
    chain.reads = tokenReads();
    await expect(verifyBoot(chain, { ...deployments, token: "0x1111111111111111111111111111111111111111", usdc: "0x1111111111111111111111111111111111111111" })).rejects.toThrow(/not USDC/);
    await expect(verifyBoot(chain, { ...deployments, escrowFactory: "0x2222222222222222222222222222222222222222" })).rejects.toThrow(/escrowFactory\(\)/);
  });
});
