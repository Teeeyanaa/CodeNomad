/**
 * Raw on-chain event store for the reasoning-registry.
 *
 * # Purpose
 *
 * This module captures every Soroban contract event emitted by the
 * reasoning-registry (and optionally other configured contract IDs), persisting
 * enough context for:
 *
 *  - Full ledger replay from any checkpoint without hitting the RPC again.
 *  - Idempotent re-ingestion: inserting the same event twice is a no-op.
 *  - Per-contract filtering via `contractIds` configuration.
 *
 * # Stored fields
 *
 * Each row stores the five-tuple that uniquely identifies a Soroban event:
 *   (network, ledger_sequence, transaction_hash, event_index, contract_id)
 * plus the full XDR payload for replay.
 *
 * # Operator configuration
 *
 * - `EVENT_STORE_PATH`   – SQLite file path (default: `./.x402-events.sqlite`).
 * - `EVENT_CONTRACT_IDS` – comma-separated contract IDs to persist; defaults
 *                           to `REASONING_REGISTRY_CONTRACT_ID` when set.
 * - `EVENT_STORE_LEDGER` – ledger mode: `memory` or `sqlite` (default: `sqlite`).
 *
 * # Schema version
 *
 * Version 1 is the initial schema.  Future incompatible changes must bump to
 * version 2 and add a migration path; the store refuses to open a file whose
 * schema version it doesn't understand.
 */

import Database from "better-sqlite3";
import { chmodSync } from "node:fs";

export const SCHEMA_VERSION = 1;

/** Identifies a single Soroban event uniquely across all networks. */
export interface EventIdentity {
  /** Stellar network passphrase or a short alias ("testnet" | "pubnet"). */
  network: string;
  /** Ledger sequence the transaction was included in. */
  ledgerSequence: number;
  /** Hex-encoded transaction hash. */
  transactionHash: string;
  /** 0-based index of this event within the transaction. */
  eventIndex: number;
  /** Bech32m contract ID that emitted the event. */
  contractId: string;
}

/** Full event row as stored and returned. */
export interface EventRow extends EventIdentity {
  /** Raw XDR bytes of the event body, base64-encoded. */
  xdrBase64: string;
  /** Wall-clock time (Unix ms) when this row was first ingested. */
  ingestedAt: number;
}

export interface EventStore {
  /**
   * Inserts one or more events.  Silently skips any row that already exists
   * (idempotent upsert keyed on `(network, ledgerSequence, transactionHash,
   * eventIndex, contractId)`).
   *
   * @returns number of *newly* inserted rows (0 means all were duplicates)
   */
  upsert(events: EventRow[]): Promise<number>;

  /**
   * Returns every event in ledger order for the given network starting at
   * (and including) `fromLedger`.  Used by the replay/sync pipeline.
   */
  since(network: string, fromLedger: number): Promise<EventRow[]>;

  /**
   * Highest ledger sequence that has been persisted for `network`.
   * Returns 0 if no events have been stored yet.
   */
  highWater(network: string): Promise<number>;

  /**
   * Returns every event emitted by `contractId` in ascending ledger order.
   */
  byContract(contractId: string): Promise<EventRow[]>;

  close(): void;
}

// ─── Memory implementation ────────────────────────────────────────────────────

export class MemoryEventStore implements EventStore {
  private rows: EventRow[] = [];

  private key(e: EventIdentity): string {
    return `${e.network}:${e.ledgerSequence}:${e.transactionHash}:${e.eventIndex}:${e.contractId}`;
  }

  private existing = new Set<string>();

  async upsert(events: EventRow[]): Promise<number> {
    let inserted = 0;
    for (const e of events) {
      const k = this.key(e);
      if (!this.existing.has(k)) {
        this.existing.add(k);
        this.rows.push({ ...e });
        inserted++;
      }
    }
    return inserted;
  }

  async since(network: string, fromLedger: number): Promise<EventRow[]> {
    return this.rows
      .filter((r) => r.network === network && r.ledgerSequence >= fromLedger)
      .sort((a, b) =>
        a.ledgerSequence !== b.ledgerSequence
          ? a.ledgerSequence - b.ledgerSequence
          : a.transactionHash !== b.transactionHash
            ? a.transactionHash.localeCompare(b.transactionHash)
            : a.eventIndex - b.eventIndex,
      );
  }

  async highWater(network: string): Promise<number> {
    let max = 0;
    for (const r of this.rows) {
      if (r.network === network && r.ledgerSequence > max) max = r.ledgerSequence;
    }
    return max;
  }

  async byContract(contractId: string): Promise<EventRow[]> {
    return this.rows
      .filter((r) => r.contractId === contractId)
      .sort((a, b) => a.ledgerSequence - b.ledgerSequence || a.eventIndex - b.eventIndex);
  }

  close(): void {
    this.rows = [];
    this.existing.clear();
  }
}

// ─── SQLite implementation ────────────────────────────────────────────────────

const CREATE_DDL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );
  INSERT OR IGNORE INTO schema_version VALUES (1);

  CREATE TABLE IF NOT EXISTS events (
    network           TEXT    NOT NULL,
    ledger_sequence   INTEGER NOT NULL,
    transaction_hash  TEXT    NOT NULL,
    event_index       INTEGER NOT NULL,
    contract_id       TEXT    NOT NULL,
    xdr_base64        TEXT    NOT NULL,
    ingested_at       INTEGER NOT NULL,
    PRIMARY KEY (network, ledger_sequence, transaction_hash, event_index, contract_id)
  );

  CREATE INDEX IF NOT EXISTS idx_events_network_ledger
    ON events (network, ledger_sequence);

  CREATE INDEX IF NOT EXISTS idx_events_contract
    ON events (contract_id, ledger_sequence, event_index);
`;

export class SqliteEventStore implements EventStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(CREATE_DDL);

    const rows = this.db
      .prepare("SELECT version FROM schema_version")
      .all() as { version: number }[];
    if (rows.length !== 1 || rows[0].version !== SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        `Unsupported event store schema (found ${JSON.stringify(rows)}, expected version ${SCHEMA_VERSION})`,
      );
    }
  }

  async upsert(events: EventRow[]): Promise<number> {
    if (events.length === 0) return 0;
    return this.db.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO events
          (network, ledger_sequence, transaction_hash, event_index,
           contract_id, xdr_base64, ingested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      let inserted = 0;
      for (const e of events) {
        const r = stmt.run(
          e.network,
          e.ledgerSequence,
          e.transactionHash,
          e.eventIndex,
          e.contractId,
          e.xdrBase64,
          e.ingestedAt,
        );
        if (r.changes === 1) inserted++;
      }
      return inserted;
    })();
  }

  async since(network: string, fromLedger: number): Promise<EventRow[]> {
    const rows = this.db
      .prepare(
        `SELECT network, ledger_sequence, transaction_hash, event_index,
                contract_id, xdr_base64, ingested_at
         FROM events
         WHERE network = ? AND ledger_sequence >= ?
         ORDER BY ledger_sequence, transaction_hash, event_index`,
      )
      .all(network, fromLedger) as DbRow[];
    return rows.map(fromDb);
  }

  async highWater(network: string): Promise<number> {
    const row = this.db
      .prepare("SELECT MAX(ledger_sequence) AS hw FROM events WHERE network = ?")
      .get(network) as { hw: number | null } | undefined;
    return row?.hw ?? 0;
  }

  async byContract(contractId: string): Promise<EventRow[]> {
    const rows = this.db
      .prepare(
        `SELECT network, ledger_sequence, transaction_hash, event_index,
                contract_id, xdr_base64, ingested_at
         FROM events
         WHERE contract_id = ?
         ORDER BY ledger_sequence, event_index`,
      )
      .all(contractId) as DbRow[];
    return rows.map(fromDb);
  }

  close(): void {
    this.db.close();
  }
}

interface DbRow {
  network: string;
  ledger_sequence: number;
  transaction_hash: string;
  event_index: number;
  contract_id: string;
  xdr_base64: string;
  ingested_at: number;
}

function fromDb(r: DbRow): EventRow {
  return {
    network: r.network,
    ledgerSequence: r.ledger_sequence,
    transactionHash: r.transaction_hash,
    eventIndex: r.event_index,
    contractId: r.contract_id,
    xdrBase64: r.xdr_base64,
    ingestedAt: r.ingested_at,
  };
}

/** Convenience factory used by the server startup path. */
export function createEventStore(
  mode?: string,
  path?: string,
): EventStore {
  const kind = mode ?? process.env.EVENT_STORE_LEDGER ?? "sqlite";
  if (kind === "memory") return new MemoryEventStore();
  const p = path ?? process.env.EVENT_STORE_PATH ?? "./.x402-events.sqlite";
  return new SqliteEventStore(p);
}
