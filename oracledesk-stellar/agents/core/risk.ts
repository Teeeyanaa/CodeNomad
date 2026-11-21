import { createHash } from "crypto";

export interface SignalObservation {
  value: number;
  timestamp: number;
  sourceId: string;
  evidenceHash: string;
}

export interface NormalizedSignal extends SignalObservation {
  ageMs: number;
}

export interface SignalAdapterOptions {
  /** Maximum allowed age of an observation in milliseconds. */
  freshnessWindowMs: number;
  /** Maximum tolerated clock skew into the future in milliseconds. */
  maxClockSkewMs?: number;
  /** Optional clock injection for deterministic tests. */
  now?: () => number;
}

export type SignalRejectionReason =
  | "malformed"
  | "future"
  | "stale"
  | "duplicate";

export class SignalRejectedError extends Error {
  readonly reason: SignalRejectionReason;

  constructor(reason: SignalRejectionReason, message: string) {
    super(message);
    this.name = "SignalRejectedError";
    this.reason = reason;
  }
}

const EVIDENCE_HASH_PATTERN = /^[a-f0-9]{64}$/i;
const REDACTED = "[redacted]";
const CREDENTIAL_PATTERN =
  /((?:api[_-]?key|secret|token|password|authorization|bearer)\s*[:=]\s*)([^\s,;]+)/gi;

/**
 * Redact credential-like substrings from free-form provider text so they never
 * leak into logs or evidence payloads.
 */
export function redactCredentials(input: string): string {
  return input.replace(CREDENTIAL_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertWellFormed(observation: unknown): asserts observation is SignalObservation {
  if (typeof observation !== "object" || observation === null) {
    throw new SignalRejectedError("malformed", "observation must be an object");
  }
  const candidate = observation as Record<string, unknown>;
  if (!isFiniteNumber(candidate.value)) {
    throw new SignalRejectedError("malformed", "observation value must be a finite number");
  }
  if (!isFiniteNumber(candidate.timestamp)) {
    throw new SignalRejectedError("malformed", "observation timestamp must be a finite number");
  }
  if (typeof candidate.sourceId !== "string" || candidate.sourceId.trim() === "") {
    throw new SignalRejectedError("malformed", "observation sourceId must be a non-empty string");
  }
  if (
    typeof candidate.evidenceHash !== "string" ||
    !EVIDENCE_HASH_PATTERN.test(candidate.evidenceHash)
  ) {
    throw new SignalRejectedError(
      "malformed",
      "observation evidenceHash must be a 64-character hex digest",
    );
  }
}

/**
 * Normalize a raw provider observation into a canonical signal record, enforcing
 * provenance (sourceId + evidenceHash) and freshness (no future, no stale, no
 * duplicate) guarantees. Throws SignalRejectedError on any violation.
 */
export function normalizeSignal(
  observation: unknown,
  options: SignalAdapterOptions,
  seenEvidenceHashes: Set<string> = new Set(),
): NormalizedSignal {
  assertWellFormed(observation);

  const now = options.now ? options.now() : Date.now();
  const maxClockSkewMs = options.maxClockSkewMs ?? 0;
  const ageMs = now - observation.timestamp;

  if (ageMs < -maxClockSkewMs) {
    throw new SignalRejectedError(
      "future",
      `observation timestamp is ${-ageMs}ms in the future (max skew ${maxClockSkewMs}ms)`,
    );
  }
  if (ageMs > options.freshnessWindowMs) {
    throw new SignalRejectedError(
      "stale",
      `observation is ${ageMs}ms old (freshness window ${options.freshnessWindowMs}ms)`,
    );
  }

  const evidenceHash = observation.evidenceHash.toLowerCase();
  if (seenEvidenceHashes.has(evidenceHash)) {
    throw new SignalRejectedError("duplicate", "observation evidenceHash already processed");
  }
  seenEvidenceHashes.add(evidenceHash);

  return {
    value: observation.value,
    timestamp: observation.timestamp,
    sourceId: observation.sourceId.trim(),
    evidenceHash,
    ageMs,
  };
}

/**
 * Compute a deterministic evidence hash for a provider payload. Useful for
 * adapters that receive raw payloads without a precomputed digest.
 */
export function computeEvidenceHash(payload: unknown): string {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  return createHash("sha256").update(serialized).digest("hex");
}
