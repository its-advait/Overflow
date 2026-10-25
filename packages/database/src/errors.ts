/** Postgres SQLSTATE for unique_violation. Same code from postgres-js and PGlite. */
export const UNIQUE_VIOLATION_CODE = "23505";

export class UniqueViolationError extends Error {
  constructor(
    public readonly constraint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(`unique constraint violated${constraint ? `: ${constraint}` : ""}`, options);
    this.name = "UniqueViolationError";
  }
}

export class NotFoundError extends Error {
  constructor(
    public readonly table: string,
    public readonly id: string,
  ) {
    super(`${table} ${id} not found`);
    this.name = "NotFoundError";
  }
}

/** A controller request already carries a different Wallet MCP submission; a second send_calls is never recorded silently. */
export class AlreadySubmittedError extends Error {
  constructor(
    public readonly id: string,
    public readonly existing: unknown,
  ) {
    super(`controller request ${id} already has a Wallet MCP submission`);
    this.name = "AlreadySubmittedError";
  }
}

/** The request is no longer pending (done or rejected), so nothing may be submitted for it. */
export class RequestNotPendingError extends Error {
  constructor(
    public readonly id: string,
    public readonly status: string,
  ) {
    super(`controller request ${id} is ${status}, not pending`);
    this.name = "RequestNotPendingError";
  }
}

interface DriverErrorShape {
  code?: unknown;
  constraint?: unknown;
  constraint_name?: unknown;
  message?: unknown;
  cause?: unknown;
}

const CONSTRAINT_IN_MESSAGE = /unique constraint "([^"]+)"/;

/** Walks the `cause` chain (Drizzle wraps driver errors) looking for a unique violation. */
function findUniqueViolation(e: unknown, depth = 0): { constraint: string | undefined } | null {
  if (!e || typeof e !== "object" || depth > 5) return null;
  const err = e as DriverErrorShape;
  if (err.code === UNIQUE_VIOLATION_CODE) {
    const named =
      (typeof err.constraint_name === "string" && err.constraint_name) ||
      (typeof err.constraint === "string" && err.constraint) ||
      (typeof err.message === "string" && CONSTRAINT_IN_MESSAGE.exec(err.message)?.[1]) ||
      undefined;
    return { constraint: named || undefined };
  }
  return findUniqueViolation(err.cause, depth + 1);
}

/** Returns a typed error for known database failures, otherwise the original. */
export function translateDbError(e: unknown): unknown {
  if (e instanceof UniqueViolationError) return e;
  const unique = findUniqueViolation(e);
  if (unique) return new UniqueViolationError(unique.constraint, { cause: e });
  return e;
}

export function isUniqueViolation(e: unknown, constraint?: string): e is UniqueViolationError {
  const t = translateDbError(e);
  if (!(t instanceof UniqueViolationError)) return false;
  return constraint === undefined || t.constraint === constraint;
}

/** Runs `fn`, rethrowing driver errors as typed errors. */
export async function withDbErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw translateDbError(e);
  }
}
