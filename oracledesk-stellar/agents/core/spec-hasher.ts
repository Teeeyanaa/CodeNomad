/**
 * Computes the commitment (`resolution_hash`) for a {@link SpecJson}. The
 * reference implementation is the Rust `scripts/spec-hash` tool, which
 * delegates to the resolver crate itself and so cannot drift from the
 * contract. A pure-TypeScript library (`@oracledesk/resolution-spec`, a
 * separate issue) is preferred when installed; with `verify` both run and
 * must agree.
 *
 * Canonical trace payload schema
 * ------------------------------
 * Trace hashing depends on canonical content, so producers and consumers
 * share an explicit schema/version contract. The canonical payload is
 * serialized with these rules:
 *
 *  - The payload is a JSON object carrying a `schemaVersion` field set to
 *    one of {@link SUPPORTED_TRACE_SCHEMA_VERSIONS}.
 *  - Object keys are emitted in ascending UTF-16 code-unit order (the same
 *    ordering `JSON.stringify` uses for integer-like keys), recursively.
 *  - Strings are UTF-8 encoded; no Unicode normalization is applied.
 *  - Numbers must be finite and are emitted in their shortest round-trip
 *    form via `JSON.stringify`; `-0` is normalized to `0`. Non-finite
 *    numbers, `bigint`, `undefined`, functions and symbols are rejected.
 *  - Arrays preserve order; `null` is preserved.
 *
 * Ambiguous encodings (duplicate keys, unsupported versions, non-canonical
 * number forms) are rejected with a clear error rather than silently hashed.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { canonicalizeSpec, toSpecHashArgs, type SpecJson } from "./spec.js";

const execFileAsync = promisify(execFile);

export interface SpecHasher {
  /** Lowercase 64-hex sha256 commitment. */
  hash(spec: SpecJson): Promise<string>;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Schema versions of the canonical trace payload this module understands. */
export const SUPPORTED_TRACE_SCHEMA_VERSIONS = [1] as const;
export type TraceSchemaVersion = (typeof SUPPORTED_TRACE_SCHEMA_VERSIONS)[number];

/** The schema version emitted by {@link canonicalTracePayload}. */
export const TRACE_SCHEMA_VERSION: TraceSchemaVersion = 1;

/** A canonical trace payload: a JSON object tagged with its schema version. */
export interface TracePayload {
  schemaVersion: TraceSchemaVersion;
  [key: string]: unknown;
}

/** Accepts exactly one non-empty output line of 64 lowercase hex chars. */
export function parseSpecHashOutput(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length !== 1 || !HEX64.test(lines[0]!.trim())) {
    throw new Error(`spec-hash: expected one line of 64 hex chars, got ${JSON.stringify(stdout)}`);
  }
  return lines[0]!.trim();
}

function assertSupportedVersion(version: unknown): asserts version is TraceSchemaVersion {
  if (!SUPPORTED_TRACE_SCHEMA_VERSIONS.includes(version as TraceSchemaVersion)) {
    throw new Error(
      `trace schema: unsupported schemaVersion ${JSON.stringify(version)}; ` +
        `supported: ${SUPPORTED_TRACE_SCHEMA_VERSIONS.join(", ")}`,
    );
  }
}

/**
 * Serializes `value` to canonical JSON per the rules documented above.
 * Throws on ambiguous or non-canonical encodings.
 */
export function canonicalTraceSerialize(value: unknown): string {
  const seen = new Set<object>();

  const encode = (node: unknown, path: string): string => {
    if (node === null) return "null";
    switch (typeof node) {
      case "string":
        return JSON.stringify(node);
      case "boolean":
        return node ? "true" : "false";
      case "number": {
        if (!Number.isFinite(node)) {
          throw new Error(`trace schema: non-finite number at ${path}`);
        }
        // Normalize -0 to 0 so the encoding is unambiguous.
        return JSON.stringify(node === 0 ? 0 : node);
      }
      case "object": {
        if (seen.has(node as object)) {
          throw new Error(`trace schema: cyclic reference at ${path}`);
        }
        seen.add(node as object);
        try {
          if (Array.isArray(node)) {
            return `[${node.map((item, i) => encode(item, `${path}[${i}]`)).join(",")}]`;
          }
          const obj = node as Record<string, unknown>;
          const keys = Object.keys(obj).sort();
          const parts = keys.map((key) => {
            const child = obj[key];
            if (child === undefined) {
              throw new Error(`trace schema: undefined value at ${path}.${key}`);
            }
            return `${JSON.stringify(key)}:${encode(child, `${path}.${key}`)}`;
          });
          return `{${parts.join(",")}}`;
        } finally {
          seen.delete(node as object);
        }
      }
      default:
        throw new Error(`trace schema: unsupported ${typeof node} at ${path}`);
    }
  };

  return encode(value, "$");
}

/**
 * Wraps `fields` in a versioned trace payload and returns its canonical
 * serialization. Rejects unsupported versions and ambiguous encodings.
 */
export function canonicalTracePayload(
  fields: Record<string, unknown>,
  version: TraceSchemaVersion = TRACE_SCHEMA_VERSION,
): string {
  assertSupportedVersion(version);
  if (Object.prototype.hasOwnProperty.call(fields, "schemaVersion")) {
    throw new Error("trace schema: fields must not set schemaVersion; it is managed by the payload");
  }
  return canonicalTraceSerialize({ ...fields, schemaVersion: version });
}

/**
 * Deterministic sha256 (lowercase 64-hex) of a canonical trace payload.
 * Used by replay to compare a reproduced trace against the archived one.
 */
export function hashTracePayload(
  fields: Record<string, unknown>,
  version: TraceSchemaVersion = TRACE_SCHEMA_VERSION,
): string {
  return createHash("sha256").update(canonicalTracePayload(fields, version), "utf8").digest("hex");
}

/**
 * Deterministic sha256 (lowercase 64-hex) of a strategy config, so archived
 * observations can be replayed against the exact config that produced them.
 */
export function hashStrategyConfig(config: unknown): string {
  return createHash("sha256").update(canonicalTraceSerialize(config), "utf8").digest("hex");
}

/**
 * Runs `scripts/spec-hash` without a shell: the prebuilt binary `bin`
 * (`SPEC_HASH_BIN`) if given, else `cargo run --quiet --manifest-path
 * <manifestPath> --`. Production images should ship the binary — the cargo
 * path needs a Rust toolchain at runtime.
 */
export class CliSpecHasher implements SpecHasher {
  private readonly timeoutMs: number;

  constructor(private readonly opts: { manifestPath: string; bin?: string; timeoutMs?: number }) {
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  async hash(spec: SpecJson): Promise<string> {
    const args = toSpecHashArgs(spec);
    const [file, argv] = this.opts.bin
      ? [this.opts.bin, args]
      : ["cargo", ["run", "--quiet", "--manifest-path", this.opts.manifestPath, "--", ...args]];
    const { stdout } = await execFileAsync(file, argv, { timeout: this.timeoutMs, windowsHide: true });
    return parseSpecHashOutput(stdout);
  }
}

/** Wraps two hashers and fails unless they agree (`--verify-spec-hash`). */
export class VerifyingSpecHasher implements SpecHasher {
  constructor(
    private readonly primary: SpecHasher,
    private readonly reference: SpecHasher,
  ) {}

  async hash(spec: SpecJson): Promise<string> {
    const [a, b] = await Promise.all([this.primary.hash(spec), this.reference.hash(spec)]);
    if (a !== b) throw new Error(`spec hash disagreement: library=${a} cli=${b}`);
    return a;
  }
}

/** Library entry points accepted from `@oracledesk/resolution-spec`. */
type SpecLibrary = {
  legacySpecHash?: (spec: SpecJson) => string | Uint8Array | Promise<string | Uint8Array>;
  hashSpec?: (spec: SpecJson) => string | Uint8Array | Promise<string | Uint8Array>;
};

/** The TS library as a {@link SpecHasher}, or `undefined` when not installed. */
export async function loadLibrarySpecHasher(moduleName = "@oracledesk/resolution-spec"): Promise<SpecHasher | undefined> {
  let lib: SpecLibrary;
  try {
    lib = (await import(moduleName)) as SpecLibrary;
  } catch {
    return undefined;
  }
  const fn = lib.legacySpecHash ?? lib.hashSpec;
  if (!fn) return undefined;
  return {
    async hash(spec) {
      const out = await fn(canonicalizeSpec(spec));
      const hex = typeof out === "string" ? out.toLowerCase() : Buffer.from(out).toString("hex");
      if (!HEX64.test(hex)) throw new Error(`resolution-spec returned a malformed hash: ${hex}`);
      return hex;
    },
  };
}

/**
 * The library when installed (cross-checked against the CLI if `verify`),
 * otherwise the CLI alone.
 */
export async function createSpecHasher(opts: {
  manifestPath: string;
  bin?: string;
  verify?: boolean;
}): Promise<SpecHasher> {
  const cli = new CliSpecHasher({ manifestPath: opts.manifestPath, bin: opts.bin });
  const lib = await loadLibrarySpecHasher();
  if (!lib) return cli;
  return opts.verify ? new VerifyingSpecHasher(lib, cli) : lib;
}
