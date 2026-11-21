const SENSITIVE_KEY =
  /(?:secret|private.?key|seed|password|passphrase|token|authorization|credential|api.?key|access.?key|signature|signed.?xdr|envelope.?xdr)/i;
const STELLAR_SECRET = /\bS[A-Z2-7]{55}\b/g;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const QUERY_SECRET = /([?&](?:token|secret|key|api[_-]?key|password|signature)=)[^&#\s]+/gi;

export const REDACTED = "[REDACTED]";

/**
 * Confidentiality boundaries for reasoning-registry traces.
 *
 * Public (safe to publish):
 * - On-chain registry metadata: agent id, reasoning CID, timestamp, hashes.
 * - IPFS CID itself (content-addressed pointer, not the payload).
 * - x402 response envelopes: status, price, payment proof references.
 * - Structured logs after redaction is applied.
 *
 * Private (must never be serialized into traces):
 * - Stellar secret keys (S...), PEM private keys, bearer tokens, credentials.
 * - Query-string secrets (token/secret/key/password/signature).
 * - Raw buffers and any field whose key matches SENSITIVE_KEY.
 *
 * Encryption boundary: trace payloads are redacted before serialization; any
 * content that must remain confidential is encrypted off-chain and only its
 * CID is published. Redaction is the last line of defense, not a substitute
 * for encryption.
 */
export const PUBLIC_TRACE_FIELDS = [
  "agentId",
  "reasoningCid",
  "timestamp",
  "contentHash",
] as const;

export function redactString(value: string): string {
  return value
    .replace(STELLAR_SECRET, REDACTED)
    .replace(PEM_PRIVATE_KEY, REDACTED)
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(QUERY_SECRET, `$1${REDACTED}`);
}

export function redact<T>(value: T): T {
  const visited = new WeakMap<object, unknown>();
  const visit = (current: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key)) return REDACTED;
    if (typeof current === "string") return redactString(current);
    if (current === null || typeof current !== "object") return current;
    if (Buffer.isBuffer(current)) return REDACTED;
    const cached = visited.get(current);
    if (cached !== undefined) return cached;
    if (Array.isArray(current)) {
      const copy: unknown[] = [];
      visited.set(current, copy);
      for (const item of current) copy.push(visit(item));
      return copy;
    }
    const copy: Record<string, unknown> = {};
    visited.set(current, copy);
    for (const [childKey, child] of Object.entries(current)) {
      copy[childKey] = visit(child, childKey);
    }
    return copy;
  };
  return visit(value) as T;
}

/**
 * Serialize a trace for publication, applying redaction first so secrets and
 * private keys never enter the serialized output.
 */
export function serializeTrace(value: unknown): string {
  return JSON.stringify(redact(value));
}

/**
 * Signal adapter: normalize provider observations into a canonical record with
 * provenance (source ID + evidence hash) and freshness checks.
 *
 * Operational outcomes (all rejections are surfaced as thrown errors so the
 * caller can log/alert deterministically):
 * - Malformed observations (missing/invalid value, timestamp, source ID or
 *   evidence hash) are rejected.
 * - Future timestamps beyond `maxClockSkewMs` are rejected.
 * - Stale timestamps older than `maxAgeMs` are rejected.
 * - Duplicate observations (same source ID + evidence hash) are rejected.
 * - Credentials embedded in source IDs / evidence hashes are redacted before
 *   they are stored or returned.
 *
 * Compatibility: `normalizeObservation` is pure and deterministic; it never
 * performs I/O and never trades. Callers keep the safe dry-run default.
 */
export interface RawObservation {
  value?: unknown;
  timestamp?: unknown;
  sourceId?: unknown;
  evidenceHash?: unknown;
}

export interface NormalizedObservation {
  value: number;
  timestamp: number;
  sourceId: string;
  evidenceHash: string;
}

export interface FreshnessOptions {
  /** Maximum allowed age of an observation in milliseconds. */
  maxAgeMs: number;
  /** Allowed clock skew into the future in milliseconds. Defaults to 0. */
  maxClockSkewMs?: number;
  /** Reference "now" in epoch milliseconds. Defaults to Date.now(). */
  now?: number;
}

const EVIDENCE_HASH = /^[A-Za-z0-9._:-]{8,}$/;
const SOURCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export class ObservationError extends Error {
  constructor(
    readonly reason:
      | "malformed"
      | "future"
      | "stale"
      | "duplicate",
    message: string,
  ) {
    super(message);
    this.name = "ObservationError";
  }
}

function parseTimestamp(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new ObservationError("malformed", "observation timestamp is invalid");
}

function parseValue(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new ObservationError("malformed", "observation value is invalid");
}

function parseString(raw: unknown, field: string, pattern: RegExp): string {
  if (typeof raw !== "string" || !pattern.test(raw)) {
    throw new ObservationError("malformed", `observation ${field} is invalid`);
  }
  return redactString(raw);
}

/**
 * Normalize a single provider observation, enforcing provenance and freshness.
 * Throws `ObservationError` on any rejection.
 */
export function normalizeObservation(
  raw: RawObservation,
  options: FreshnessOptions,
): NormalizedObservation {
  if (!raw || typeof raw !== "object") {
    throw new ObservationError("malformed", "observation is not an object");
  }
  const value = parseValue(raw.value);
  const timestamp = parseTimestamp(raw.timestamp);
  const sourceId = parseString(raw.sourceId, "sourceId", SOURCE_ID);
  const evidenceHash = parseString(raw.evidenceHash, "evidenceHash", EVIDENCE_HASH);

  const now = options.now ?? Date.now();
  const skew = options.maxClockSkewMs ?? 0;
  if (timestamp > now + skew) {
    throw new ObservationError("future", "observation timestamp is in the future");
  }
  if (now - timestamp > options.maxAgeMs) {
    throw new ObservationError("stale", "observation is older than the freshness window");
  }

  return { value, timestamp, sourceId, evidenceHash };
}

/**
 * Normalize a batch of observations, rejecting duplicates (same source ID and
 * evidence hash) within the batch. Returns only accepted observations.
 */
export function normalizeObservations(
  raws: RawObservation[],
  options: FreshnessOptions,
): NormalizedObservation[] {
  const seen = new Set<string>();
  const accepted: NormalizedObservation[] = [];
  for (const raw of raws) {
    const normalized = normalizeObservation(raw, options);
    const key = `${normalized.sourceId}\u0000${normalized.evidenceHash}`;
    if (seen.has(key)) {
      throw new ObservationError("duplicate", "duplicate observation detected");
    }
    seen.add(key);
    accepted.push(normalized);
  }
  return accepted;
}
