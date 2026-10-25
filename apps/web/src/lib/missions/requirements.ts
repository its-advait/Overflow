import {
  FormatSchema,
  GranularitySchema,
  LicenseSchema,
  ResourceRequestSchema,
  formatUsdc,
  type Format,
  type Granularity,
  type License,
  type ResourceRequest,
  type ResourceRequestRecord,
} from "@overflow/schemas";
import { parseBudgetInput } from "./budget";

// The editable requirements table (SPEC "Oracle": the user can edit the
// extracted requirements before any purchase). A row is edited as plain text
// fields and validated back into a ResourceRequest with the same Zod schema the
// service applies, so the PUT body is exactly what the service accepts.

export const GRANULARITIES = GranularitySchema.options;
export const LICENSES = LicenseSchema.options;
export const FORMATS = FormatSchema.options;

export interface RequirementDraft {
  topic: string;
  /** Comma-separated region codes. */
  regions: string;
  start: string;
  end: string;
  granularity: Granularity;
  /** Comma-separated column names. */
  requiredFields: string;
  format: Format[];
  license: License;
  maxAgeDays: string;
  /** Human USDC, e.g. "12.50". */
  maxPriceUsdc: string;
}

export function toDraft(r: ResourceRequest): RequirementDraft {
  return {
    topic: r.topic,
    regions: r.regions.join(", "),
    start: r.dateRange.start,
    end: r.dateRange.end,
    granularity: r.granularity,
    requiredFields: r.requiredFields.join(", "),
    format: [...r.format],
    license: r.license,
    maxAgeDays: String(r.freshness.maxAgeDays),
    maxPriceUsdc: formatUsdc(r.maxPriceAtomic, { trimZeros: true }),
  };
}

export type DraftParse = { ok: true; request: ResourceRequest } | { ok: false; issues: Record<string, string> };

const splitList = (text: string): string[] => [...new Set(text.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];

export function fromDraft(d: RequirementDraft): DraftParse {
  const issues: Record<string, string> = {};
  const price = parseBudgetInput(d.maxPriceUsdc);
  if (!price.ok) issues["maxPriceAtomic"] = price.error;
  const maxAgeDays = /^\d+$/.test(d.maxAgeDays.trim()) ? Number(d.maxAgeDays.trim()) : NaN;
  if (!Number.isInteger(maxAgeDays) || maxAgeDays <= 0) issues["freshness"] = "Freshness must be a whole number of days above 0.";

  const parsed = ResourceRequestSchema.safeParse({
    topic: d.topic.trim(),
    regions: splitList(d.regions),
    dateRange: { start: d.start.trim(), end: d.end.trim() },
    granularity: d.granularity,
    requiredFields: splitList(d.requiredFields).map((f) => f.toLowerCase()),
    format: [...new Set(d.format)],
    license: d.license,
    freshness: { maxAgeDays: Number.isInteger(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : 1 },
    maxPriceAtomic: price.ok ? price.atomic : "0",
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "request");
      if (!(key in issues)) issues[key] = issue.message;
    }
  }
  if (Object.keys(issues).length > 0) return { ok: false, issues };
  return { ok: true, request: parsed.data! };
}

/** Rows grouped per requesting agent; withdrawn rows (replaced by a re-plan) are left out, their count returned. */
export function groupByAgent(requests: readonly ResourceRequestRecord[]): { groups: { agentId: string; requests: ResourceRequestRecord[] }[]; withdrawn: number } {
  const groups = new Map<string, ResourceRequestRecord[]>();
  let withdrawn = 0;
  for (const r of requests) {
    if (r.status === "withdrawn") {
      withdrawn++;
      continue;
    }
    const list = groups.get(r.agentId) ?? [];
    list.push(r);
    groups.set(r.agentId, list);
  }
  return {
    groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([agentId, rs]) => ({ agentId, requests: rs })),
    withdrawn,
  };
}
