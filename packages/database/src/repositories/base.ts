import { randomUUID } from "node:crypto";
import type { z } from "zod";

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();

/** Date column -> ISO-8601 string the schemas accept. */
export const iso = (d: Date): string => d.toISOString();
export const isoOpt = (d: Date | null | undefined): string | undefined =>
  d == null ? undefined : d.toISOString();
export const toDate = (s: string): Date => new Date(s);
export const toDateOpt = (s: string | undefined): Date | null => (s == null ? null : new Date(s));

/** Nullable column -> optional field. */
export const opt = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);
/** Optional field -> nullable column. */
export const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** Parses every row through the schema so callers only ever see validated objects. */
export function parseRows<S extends z.ZodType>(schema: S, rows: unknown[]): z.output<S>[] {
  return rows.map((r) => schema.parse(r));
}

export function parseOne<S extends z.ZodType>(schema: S, row: unknown): z.output<S> {
  return schema.parse(row);
}

/** Fields the repository fills in when the caller omits them. */
export type WithOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
