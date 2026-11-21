/**
 * The market-maker's commit → persist → create → reveal sequence (ADR 0001,
 * "Agent flow and recovery"). Kept free of CLI wiring so the ordering
 * guarantees — above all "no create before the spec is durably stored" —
 * are unit-testable.
 */
import { NotSubmittedError, type AdapterResult } from "../stellar/adapter.js";
import { validateCloseTime, validateSpec, type SpecJson } from "./spec.js";
import type { SpecHasher } from "./spec-hasher.js";
import { newStoredSpec, revealStored, type RecoveryChain, type SpecStore, type StoredSpec } from "./spec-store.js";

/**
 * Stable strategy plugin contract (issue #53).
 *
 * A strategy is a pure, deterministic decision function: given the current
 * market context it returns either a spec to create or `null` to abstain.
 * Strategies must not perform I/O, submit transactions, or read wall-clock
 * time directly — the runtime owns scheduling and the dry-run default, and
 * passes everything a strategy needs through `StrategyContext`.
 */
export interface StrategyContext {
  /** Unix seconds; supplied by the runtime so strategies stay deterministic. */
  nowSecs: number;
  /** Free-form, already-validated parameters from startup config. */
  params: Readonly<Record<string, unknown>>;
}

/** A maker strategy proposes a market spec to create. */
export interface MakerStrategy {
  readonly kind: "maker";
  readonly name: string;
  /** Returns a spec to create, or `null` to abstain this tick. */
  propose(ctx: StrategyContext): SpecJson | null;
}

/** A trader strategy proposes a trade intent (opaque to the runtime). */
export interface TraderStrategy {
  readonly kind: "trader";
  readonly name: string;
  /** Returns a trade intent, or `null` to abstain this tick. */
  propose(ctx: StrategyContext): TradeIntent | null;
}

export interface TradeIntent {
  marketId: string;
  side: "buy" | "sell";
  /** Base units, as a decimal string to avoid float drift. */
  amount: string;
}

export type Strategy = MakerStrategy | TraderStrategy;

/**
 * Validates a strategy selection at startup. Throws on unknown names or
 * malformed parameters so misconfiguration fails fast rather than silently
 * falling back to a default.
 */
export function validateStrategyConfig(
  registry: Readonly<Record<string, Strategy>>,
  name: string,
  params: Record<string, unknown> = {},
): Strategy {
  const strategy = registry[name];
  if (!strategy) {
    const known = Object.keys(registry).sort().join(", ") || "<none>";
    throw new Error(`unknown strategy "${name}" (known: ${known})`);
  }
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`strategy "${name}" params must be an object`);
  }
  return strategy;
}

/**
 * Built-in deterministic maker strategy: proposes the supplied spec verbatim.
 * Useful as a baseline and for replay tests.
 */
export function fixedMakerStrategy(name: string, spec: SpecJson): MakerStrategy {
  return {
    kind: "maker",
    name,
    propose: () => spec,
  };
}

export interface CreateWithSpecArgs {
  spec: SpecJson;
  questionHash: Buffer;
  closeTime: bigint;
  /** Minimum gap past `now + dispute_window` for `closeTime`. */
  closeMarginSecs?: number;
  store: SpecStore;
  hasher: SpecHasher;
  chain: RecoveryChain;
  /** Submits agent_create_market with the given resolution_hash. */
  create: (resolutionHash: Buffer) => Promise<AdapterResult<bigint>>;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface CreateWithSpecResult {
  commitment: string;
  entry: StoredSpec;
  create: AdapterResult<bigint>;
  /** Live only: whether the immediate reveal succeeded. When false the
   * entry stays `created` and recovery retries it. */
  revealed?: boolean;
}

export async function createMarketWithSpec(args: CreateWithSpecArgs): Promise<CreateWithSpecResult> {
  const now = args.now ?? Date.now;
  const log = args.log ?? ((m) => console.log(m));

  validateSpec(args.spec);
  validateCloseTime(args.closeTime, Math.floor(now() / 1000), args.spec, args.closeMarginSecs);
  const commitment = await args.hasher.hash(args.spec);

  let entry = newStoredSpec({
    commitment,
    spec: args.spec,
    questionHash: args.questionHash.toString("hex"),
    closeTime: args.closeTime,
    now: now(),
  });
  // Durability barrier: if this throws, no create is ever attempted.
  await args.store.put(entry);

  let create: AdapterResult<bigint>;
  try {
    create = await args.create(Buffer.from(commitment, "hex"));
  } catch (err) {
    if (err instanceof NotSubmittedError) {
      // Rejected before submission (e.g. TradeCapExceeded): no market exists.
      await args.store.put({ ...entry, state: "abandoned", lastError: err.message, updatedAt: now() });
    }
    // Otherwise the create may have landed; leave pending_create for recovery.
    throw err;
  }
  if (create.dryRun) return { commitment, entry, create };

  entry = { ...entry, state: "created", marketId: create.value.toString(), updatedAt: now() };
  await args.store.put(entry);

  try {
    entry = await revealStored(args.store, args.chain, entry, now());
    return { commitment, entry, create, revealed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    entry = { ...entry, lastError: message, updatedAt: now() };
    await args.store.put(entry);
    log(`[market-maker] reveal for market ${entry.marketId} failed, recovery will retry: ${message}`);
    return { commitment, entry, create, revealed: false };
  }
}
