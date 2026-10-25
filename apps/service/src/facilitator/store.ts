/**
 * Idempotency records keyed by the authorization digest (settle/reserve), `release:<digest>` or a delegation
 * digest. A repeated key answers 409 with the original record, whatever its status. In-memory for now; the
 * interface is what a Postgres-backed store will implement (docs/SPEC.md `reservations`).
 */
export type RecordStatus = "pending" | "done" | "unknown";

export type StoreRecord = {
  key: string;
  route: string;
  status: RecordStatus;
  createdAt: string;
  updatedAt: string;
  txHash?: `0x${string}`;
  result?: unknown;
};

export interface Store {
  get(key: string): Promise<StoreRecord | undefined>;
  /** Insert only; returns false (and leaves the existing record) when the key already exists. */
  create(rec: StoreRecord): Promise<boolean>;
  update(key: string, patch: Partial<Pick<StoreRecord, "status" | "txHash" | "result">>): Promise<void>;
  list(): Promise<StoreRecord[]>;
}

export class MemoryStore implements Store {
  private readonly m = new Map<string, StoreRecord>();
  constructor(private readonly now: () => Date = () => new Date()) {}
  async get(key: string) {
    return this.m.get(key);
  }
  async create(rec: StoreRecord) {
    if (this.m.has(rec.key)) return false;
    this.m.set(rec.key, { ...rec });
    return true;
  }
  async update(key: string, patch: Partial<Pick<StoreRecord, "status" | "txHash" | "result">>) {
    const cur = this.m.get(key);
    if (!cur) throw new Error(`store: unknown key ${key}`);
    this.m.set(key, { ...cur, ...patch, updatedAt: this.now().toISOString() });
  }
  async list() {
    return [...this.m.values()];
  }
}
