import { describe, expect, it } from "vitest";
import {
  AtomicAmountSchema,
  MoneyFormatError,
  atomicToBigInt,
  bigIntToAtomic,
  formatUsdc,
  sumAtomic,
  toAtomic,
} from "./index";

describe("toAtomic", () => {
  it.each([
    ["8.40", "8400000"],
    ["8.4", "8400000"],
    ["12", "12000000"],
    ["0.000001", "1"],
    ["0", "0"],
    ["0.0", "0"],
    ["00.5", "500000"],
    ["3.60", "3600000"],
    ["0.01", "10000"],
    ["50", "50000000"],
    ["1234567890123.123456", "1234567890123123456"],
  ])("toAtomic(%j) === %j", (human, atomic) => {
    expect(toAtomic(human)).toBe(atomic);
  });

  it.each(["1.1234567", "abc", "", "-1", "1e3", ".5", "1.", " 1", "1 ", "1,000", "0x10", "+1", "1.5.5"])(
    "rejects %j",
    (bad) => {
      expect(() => toAtomic(bad)).toThrow(MoneyFormatError);
    },
  );

  it("rejects a number argument at runtime", () => {
    expect(() => toAtomic(8.4 as unknown as string)).toThrow(MoneyFormatError);
  });

  it("output always satisfies AtomicAmountSchema", () => {
    for (const h of ["0", "0.5", "8.40", "100000000000"]) {
      expect(AtomicAmountSchema.safeParse(toAtomic(h)).success).toBe(true);
    }
  });
});

describe("formatUsdc", () => {
  it.each([
    ["8400000", "8.40"],
    ["12000000", "12.00"],
    ["1", "0.000001"],
    ["0", "0.00"],
    ["10000", "0.01"],
    ["3600000", "3.60"],
    ["123456789", "123.456789"],
  ])("formatUsdc(%j) === %j", (atomic, human) => {
    expect(formatUsdc(atomic)).toBe(human);
  });

  it("accepts bigint and honours options", () => {
    expect(formatUsdc(8400000n)).toBe("8.40");
    expect(formatUsdc("8400000", { trimZeros: false })).toBe("8.400000");
    expect(formatUsdc("8000000", { minFractionDigits: 0 })).toBe("8");
    expect(formatUsdc("8400000", { minFractionDigits: 0 })).toBe("8.4");
  });

  it("round-trips through toAtomic", () => {
    for (const h of ["8.40", "12.00", "0.000001", "0.01", "999999.999999"]) {
      expect(formatUsdc(toAtomic(h))).toBe(h);
    }
  });

  it("rejects floats and negatives", () => {
    expect(() => formatUsdc("1.5")).toThrow();
    expect(() => formatUsdc(-1n)).toThrow(MoneyFormatError);
  });
});

describe("bigint helpers", () => {
  it("converts both ways and sums", () => {
    expect(atomicToBigInt("8400000")).toBe(8400000n);
    expect(atomicToBigInt(5n)).toBe(5n);
    expect(bigIntToAtomic(8400000n)).toBe("8400000");
    expect(sumAtomic(["8400000", "3600000"])).toBe("12000000");
    expect(sumAtomic(["8400000", 3600000n])).toBe("12000000");
    expect(sumAtomic([])).toBe("0");
  });

  it("rejects malformed inputs", () => {
    expect(() => atomicToBigInt("01")).toThrow();
    expect(() => atomicToBigInt("1.0")).toThrow();
    expect(() => bigIntToAtomic(-1n)).toThrow();
  });
});

describe("AtomicAmountSchema", () => {
  it.each(["0", "1", "1000000", "115792089237316195423570985008687907853269984665640564039457584007913129639935"])(
    "accepts %j",
    (v) => expect(AtomicAmountSchema.safeParse(v).success).toBe(true),
  );

  it.each([
    "1.5",
    "01",
    "-1",
    "",
    "1e6",
    "0x10",
    " 1",
    "115792089237316195423570985008687907853269984665640564039457584007913129639936",
  ])("rejects %j", (v) => expect(AtomicAmountSchema.safeParse(v).success).toBe(false));

  it("rejects numbers and bigints (strings only)", () => {
    expect(AtomicAmountSchema.safeParse(1).success).toBe(false);
    expect(AtomicAmountSchema.safeParse(1n).success).toBe(false);
  });
});
