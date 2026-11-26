/**
 * x402 protocol version negotiation and compatibility rules.
 *
 * The x402 wire protocol carries a `x402Version` integer field.  This module
 * defines which versions the server accepts, how it selects the best common
 * version with a client, and what versioned error shapes look like so that
 * older clients can still parse a 402 or 4xx response from a newer server.
 *
 * # Versioning policy
 *
 * - Version 1 (legacy) – the original `payment-required` / `payment` header
 *   scheme.  Payload structure differs from v2.
 * - Version 2 (current) – base64-encoded JSON header; the `PaymentPayload`
 *   shape accepted by `@x402/core` 2.x.
 * - Future versions must remain backward-compatible with v2 clients: any new
 *   field must be optional or under an extension key.  Breaking changes
 *   require a new version number.
 *
 * # Negotiation algorithm
 *
 * 1. Client advertises `x402Version` in its payment header.
 * 2. `negotiate()` picks the highest version that both sides support.
 * 3. If no common version exists, the server returns a versioned
 *    `VersionNotSupported` error so old clients know to upgrade.
 *
 * # Operator configuration
 *
 * Set `X402_MIN_VERSION` and `X402_MAX_VERSION` env vars to constrain the
 * accepted range (default: min=2, max=2).  Setting min=1 is a migration aid
 * for a staged rollout of v2 clients; it will be removed in a future release.
 */

export const PROTOCOL_MIN_VERSION = 1;
export const PROTOCOL_MAX_VERSION = 2;
export const CURRENT_VERSION = 2;

/** Version range the server exposes.  Operator-overridable via env vars. */
export interface VersionPolicy {
  minVersion: number;
  maxVersion: number;
}

export function defaultVersionPolicy(): VersionPolicy {
  const min = Number(process.env.X402_MIN_VERSION ?? PROTOCOL_MIN_VERSION);
  const max = Number(process.env.X402_MAX_VERSION ?? CURRENT_VERSION);
  assertValidPolicy({ minVersion: min, maxVersion: max });
  return { minVersion: min, maxVersion: max };
}

export function assertValidPolicy(p: VersionPolicy): void {
  if (
    !Number.isInteger(p.minVersion) || !Number.isInteger(p.maxVersion) ||
    p.minVersion < PROTOCOL_MIN_VERSION || p.maxVersion > PROTOCOL_MAX_VERSION ||
    p.minVersion > p.maxVersion
  ) {
    throw new Error(
      `Invalid version policy: min=${p.minVersion} max=${p.maxVersion}; ` +
      `supported range is [${PROTOCOL_MIN_VERSION}, ${PROTOCOL_MAX_VERSION}]`,
    );
  }
}

/** Versioned error shape, stable across all supported protocol versions. */
export interface VersionedError {
  /** Machine-readable error code. */
  error: string;
  /** Minimum version the server requires when `error` is "version_not_supported". */
  minVersion?: number;
  /** Maximum version the server supports. */
  maxVersion?: number;
  /** Human-readable detail. */
  message?: string;
}

/** Result of version negotiation. */
export type NegotiationResult =
  | { ok: true; version: number }
  | { ok: false; error: VersionedError; httpStatus: 402 | 400 };

/**
 * Select the best common version between client and server.
 *
 * @param clientVersion  The `x402Version` the client announced.
 * @param policy         The server's configured version range.
 */
export function negotiate(
  clientVersion: number | undefined,
  policy: VersionPolicy = defaultVersionPolicy(),
): NegotiationResult {
  if (clientVersion === undefined || !Number.isInteger(clientVersion) || clientVersion < 1) {
    return {
      ok: false,
      httpStatus: 402,
      error: {
        error: "version_missing",
        message: "Payment header must include a valid x402Version",
        minVersion: policy.minVersion,
        maxVersion: policy.maxVersion,
      },
    };
  }

  const lo = Math.max(clientVersion, policy.minVersion);
  const hi = Math.min(clientVersion, policy.maxVersion);

  if (lo > hi) {
    return {
      ok: false,
      httpStatus: 402,
      error: {
        error: "version_not_supported",
        message:
          `Client requested version ${clientVersion}; ` +
          `server supports [${policy.minVersion}, ${policy.maxVersion}]`,
        minVersion: policy.minVersion,
        maxVersion: policy.maxVersion,
      },
    };
  }

  // Pick the highest mutually supported version.
  return { ok: true, version: hi };
}

/**
 * Returns whether a client running `clientVersion` can parse a response
 * produced at `serverVersion`.  Used to gate whether a replay or error
 * response can be safely sent to this client without upgrade.
 */
export function isCompatible(clientVersion: number, serverVersion: number): boolean {
  // v2 responses are backward-compatible with v2 clients only.
  // v1 clients require v1 responses.
  if (clientVersion === serverVersion) return true;
  if (clientVersion === 1 && serverVersion === 2) return false; // v1 client can't parse v2
  if (clientVersion === 2 && serverVersion >= 2) return true;  // v2+ responses are v2-compatible
  return false;
}

/**
 * Builds the value for the `Deprecation` response header when the negotiated
 * version is below the current version.  Returns undefined if no deprecation
 * header is needed.
 *
 * RFC 8594 date format: IMF-fixdate.
 */
export function deprecationHeader(version: number): string | undefined {
  if (version >= CURRENT_VERSION) return undefined;
  // Version 1 was deprecated 2024-01-01.
  return "Sat, 01 Jan 2024 00:00:00 GMT";
}

/**
 * Extracts the `x402Version` integer from a raw base64-encoded payment header
 * without fully parsing the payload.  Returns `undefined` on any parse error.
 */
export function extractVersion(header: string): number | undefined {
  try {
    const obj = JSON.parse(Buffer.from(header, "base64").toString());
    const v = (obj as Record<string, unknown>)["x402Version"];
    return typeof v === "number" ? v : undefined;
  } catch {
    return undefined;
  }
}
