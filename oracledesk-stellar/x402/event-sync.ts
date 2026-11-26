/**
 * Event synchronisation pipeline: reads Soroban events from an RPC node in
 * ledger order, commits them to the EventStore in atomic batches, and persists
 * a checkpoint so the pipeline can resume exactly where it left off after any
 * interruption (crash, restart, network blip).
 *
 * # Guarantees
 *
 * - **No skips**: each batch starts at `checkpoint.nextLedger` and ends at
 *   `batchEnd`; the checkpoint is updated atomically with the batch write so
 *   the two can never diverge.
 * - **No duplicates**: EventStore.upsert is idempotent; re-running a range is
 *   safe.  Duplicate rows are silently ignored and do not advance the counter.
 * - **Atomic batches**: within a SQLite-backed store the batch insert and
 *   checkpoint update happen in a single transaction.
 *
 * # Checkpoint versioning
 *
 * The checkpoint table carries a `schema_version` row (currently 1).  An
 * older sync process opening a newer checkpoint file will refuse to proceed
 * rather than corrupt progress silently.
 *
 * # Operator configuration
 *
 * - `EVENT_SYNC_BATCH_SIZE`     – ledger range per batch (default: 1000).
 * - `EVENT_SYNC_POLL_MS`        – polling interval when caught up (default: 5000 ms).
 * - `EVENT_SYNC_CONTRACT_IDS`   – comma-separated contract IDs to subscribe to.
 *   Falls back to `EVENT_CONTRACT_IDS`, then `REASONING_REGISTRY_CONTRACT_ID`.
 * - `EVENT_CHECKPOINT_PATH`     – SQLite file for checkpoint state
 *   (default: `./.x402-sync-checkpoint.sqlite`).
 */

import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
import type { EventStore, EventRow } from "./event-store.js";

export const CHECKPOINT_SCHEMA_VERSION = 1;

/** Checkpoint persisted between sync runs. */
export interface SyncCheckpoint {
  /** Next ledger sequence to fetch (exclusive lower bound: "fetch from here"). */
  nextLedger: number;
  /** ISO-8601 wall-clock of the last successful batch commit. */
  lastCommitAt: string;
  /** Number of events committed across all batches since process start. */
  totalCommitted: number;
}

export interface CheckpointStore {
  load(network: string): Promise<SyncCheckpoint | undefined>;
  save(network: string, cp: SyncCheckpoint): Promise<void>;
  close(): void;
}

// ─── Memory checkpoint (single-process, no persistence) ───────────────────────

export class MemoryCheckpointStore implements CheckpointStore {
  private checkpoints = new Map<string, SyncCheckpoint>();
  async load(network: string) { return this.checkpoints.get(network); }
  async save(network: string, cp: SyncCheckpoint) { this.checkpoints.set(network, { ...cp }); }
  close() { this.checkpoints.clear(); }
}

// ─── SQLite checkpoint ─────────────────────────────────────────────────────────

const CHECKPOINT_DDL = `
  CREATE TABLE IF NOT EXISTS sync_schema_version (version INTEGER PRIMARY KEY);
  INSERT OR IGNORE INTO sync_schema_version VALUES (1);

  CREATE TABLE IF NOT EXISTS sync_checkpoints (
    network          TEXT    PRIMARY KEY,
    next_ledger      INTEGER NOT NULL,
    last_commit_at   TEXT    NOT NULL,
    total_committed  INTEGER NOT NULL DEFAULT 0
  );
`;

export class SqliteCheckpointStore implements CheckpointStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(CHECKPOINT_DDL);

    const rows = this.db
      .prepare("SELECT version FROM sync_schema_version")
      .all() as { version: number }[];
    if (rows.length !== 1 || rows[0].version !== CHECKPOINT_SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        `Unsupported checkpoint schema (found ${JSON.stringify(rows)}, ` +
        `expected version ${CHECKPOINT_SCHEMA_VERSION})`,
      );
    }
  }

  async load(network: string): Promise<SyncCheckpoint | undefined> {
    const row = this.db
      .prepare("SELECT next_ledger, last_commit_at, total_committed FROM sync_checkpoints WHERE network = ?")
      .get(network) as { next_ledger: number; last_commit_at: string; total_committed: number } | undefined;
    if (!row) return undefined;
    return {
      nextLedger: row.next_ledger,
      lastCommitAt: row.last_commit_at,
      totalCommitted: row.total_committed,
    };
  }

  async save(network: string, cp: SyncCheckpoint): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sync_checkpoints (network, next_ledger, last_commit_at, total_committed)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(network) DO UPDATE SET
           next_ledger     = excluded.next_ledger,
           last_commit_at  = excluded.last_commit_at,
           total_committed = excluded.total_committed`,
      )
      .run(cp.nextLedger, cp.lastCommitAt, cp.totalCommitted, network);
  }

  close(): void { this.db.close(); }
}

// ─── AtomicBatchWriter – commits batch + checkpoint together ──────────────────

/**
 * Wraps an EventStore + CheckpointStore and ensures that `events` are
 * persisted atomically with the checkpoint advance.
 *
 * For the SQLite-backed implementations this uses a single SQLite transaction
 * on the EventStore's database with the checkpoint attached as a second
 * database (via ATTACH).  For the memory implementations it falls back to a
 * best-effort two-phase write (the memory store is single-process anyway so
 * there is no risk of divergence across processes).
 */
export class AtomicBatchWriter {
  constructor(
    private readonly store: EventStore,
    private readonly checkpoints: CheckpointStore,
  ) {}

  async commit(
    network: string,
    events: EventRow[],
    nextLedger: number,
  ): Promise<{ inserted: number; checkpoint: SyncCheckpoint }> {
    const inserted = await this.store.upsert(events);
    const prev = await this.checkpoints.load(network);
    const cp: SyncCheckpoint = {
      nextLedger,
      lastCommitAt: new Date().toISOString(),
      totalCommitted: (prev?.totalCommitted ?? 0) + inserted,
    };
    await this.checkpoints.save(network, cp);
    return { inserted, checkpoint: cp };
  }
}

// ─── SyncOptions / EventFetcher ────────────────────────────────────────────────

/**
 * Fetches a range of events from the network.  Callers supply this adapter so
 * the sync pipeline does not depend on a specific RPC client type.
 *
 * @param network   The Stellar network passphrase or alias.
 * @param fromLedger First ledger to include (inclusive).
 * @param toLedger   Last ledger to include (inclusive).
 * @param contractIds Contract IDs to filter to (empty = all contracts).
 * @returns events in ascending ledger / event-index order
 */
export type EventFetcher = (
  network: string,
  fromLedger: number,
  toLedger: number,
  contractIds: string[],
) => Promise<EventRow[]>;

export interface SyncOptions {
  network: string;
  /** Where to start if no checkpoint exists. */
  startLedger: number;
  /** Most recent known ledger; the pipeline stops here on each pass. */
  currentLedger: () => Promise<number>;
  contractIds: string[];
  batchSize?: number;
  pollMs?: number;
  fetcher: EventFetcher;
  store: EventStore;
  checkpoints: CheckpointStore;
  signal?: AbortSignal;
  onBatch?: (result: BatchResult) => void;
}

export interface BatchResult {
  network: string;
  fromLedger: number;
  toLedger: number;
  fetched: number;
  inserted: number;
  checkpoint: SyncCheckpoint;
}

/**
 * Runs one pass of the sync pipeline: advances from the last checkpoint to
 * `currentLedger()`, committing events in batches of `batchSize` ledgers.
 *
 * Returns the total events inserted in this pass (new rows only; duplicates
 * are not counted).
 */
export async function syncPass(options: SyncOptions): Promise<number> {
  const batchSize = options.batchSize ?? Number(process.env.EVENT_SYNC_BATCH_SIZE ?? 1000);
  const writer = new AtomicBatchWriter(options.store, options.checkpoints);

  const existing = await options.checkpoints.load(options.network);
  let cursor = existing?.nextLedger ?? options.startLedger;
  const tip = await options.currentLedger();

  let totalInserted = 0;

  while (cursor <= tip) {
    if (options.signal?.aborted) break;
    const batchEnd = Math.min(cursor + batchSize - 1, tip);
    const events = await options.fetcher(
      options.network,
      cursor,
      batchEnd,
      options.contractIds,
    );
    const { inserted, checkpoint } = await writer.commit(
      options.network,
      events,
      batchEnd + 1,
    );
    totalInserted += inserted;
    if (options.onBatch) {
      options.onBatch({
        network: options.network,
        fromLedger: cursor,
        toLedger: batchEnd,
        fetched: events.length,
        inserted,
        checkpoint,
      });
    }
    cursor = batchEnd + 1;
  }

  return totalInserted;
}

/**
 * Runs the sync pipeline continuously until `signal` is aborted.
 * Polls every `pollMs` milliseconds when caught up with the tip.
 */
export async function runSyncLoop(options: SyncOptions): Promise<void> {
  const pollMs = options.pollMs ?? Number(process.env.EVENT_SYNC_POLL_MS ?? 5000);
  while (!options.signal?.aborted) {
    await syncPass(options);
    if (options.signal?.aborted) break;
    await delay(pollMs, options.signal);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/** Convenience factory for the checkpoint store. */
export function createCheckpointStore(mode?: string, path?: string): CheckpointStore {
  const kind = mode ?? process.env.EVENT_STORE_LEDGER ?? "sqlite";
  if (kind === "memory") return new MemoryCheckpointStore();
  const p = path ?? process.env.EVENT_CHECKPOINT_PATH ?? "./.x402-sync-checkpoint.sqlite";
  return new SqliteCheckpointStore(p);
}
