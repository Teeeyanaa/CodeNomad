/**
 * Tests for event-store.ts (MemoryEventStore and SqliteEventStore).
 *
 * # What is covered
 *
 * Success path
 *   - upsert inserts new events and returns the correct inserted count.
 *   - since returns events ≥ fromLedger in ascending order.
 *   - highWater returns the max ledger sequence seen.
 *   - byContract filters by contract ID.
 *
 * Failure / boundary
 *   - upsert is idempotent: re-inserting the same event returns 0 and does
 *     not create a duplicate row.
 *   - Partial re-insert (some new, some duplicate) counts only new rows.
 *   - since with fromLedger beyond the high water mark returns an empty array.
 *   - upsert([]) is a no-op returning 0.
 *   - SQLite: schema version mismatch is rejected on open.
 *   - SQLite: data persists after close/reopen.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryEventStore,
  SqliteEventStore,
  SCHEMA_VERSION,
  type EventRow,
  type EventStore,
} from "./event-store.js";
import Database from "better-sqlite3";

function row(overrides: Partial<EventRow> = {}): EventRow {
  return {
    network: "testnet",
    ledgerSequence: 1000,
    transactionHash: "aabbcc" + "00".repeat(29),
    eventIndex: 0,
    contractId: "CCONTRACT00001",
    xdrBase64: "AAAA",
    ingestedAt: 1_700_000_000_000,
    ...overrides,
  };
}

for (const kind of ["memory", "sqlite"] as const) {
  test(`${kind}: upsert inserts new events, returns correct count`, async () => {
    const { store, cleanup } = makeStore(kind);
    try {
      const events = [
        row({ ledgerSequence: 100, transactionHash: "aabb" + "00".repeat(30), eventIndex: 0 }),
        row({ ledgerSequence: 100, transactionHash: "aabb" + "00".repeat(30), eventIndex: 1 }),
        row({ ledgerSequence: 101, transactionHash: "ccdd" + "00".repeat(30), eventIndex: 0 }),
      ];
      const n = await store.upsert(events);
      assert.equal(n, 3);
    } finally {
      store.close();
      cleanup();
    }
  });

  test(`${kind}: upsert is idempotent — duplicate insert returns 0`, async () => {
    const { store, cleanup } = makeStore(kind);
    try {
      const events = [row({ ledgerSequence: 100 })];
      await store.upsert(events);
      const n2 = await store.upsert(events);
      assert.equal(n2, 0);
    } finally {
      store.close();
      cleanup();
    }
  });

  test(`${kind}: partial re-insert counts only new rows`, async () => {
    const { store, cleanup } = makeStore(kind);
    try {
      const existing = row({ ledgerSequence: 50, eventIndex: 0 });
      const fresh = row({ ledgerSequence: 50, eventIndex: 1 });
      await store.upsert([existing]);
      const n = await store.upsert([existing, fresh]);
      assert.equal(n, 1);
    } finally {
      store.close();
      cleanup();
    }
  });

  test(`${kind}: upsert([]) is a no-op returning 0`, async () => {
    const { store, cleanup } = makeStore(kind);
    try {
      const n = await store.upsert([]);
      assert.equal(n, 0);
    } finally {
      store.close();
      cleanup();
    }
  });

  test(`${kind}: since returns events in ascending ledger/index order`, async () => {
    const { store, cleanup } = makeStore(kind);
    try {
      await store.upsert([
        row({ ledgerSequence: 200, transactionHash: "ccdd" + "00".repeat(30), eventIndex: 0 }),
        row({ ledgerSequence: 100, transactionHash: "aabb" + "00".repeat(30), eventIndex: 0 }),
        row({ ledgerSequence: 100, transactionHash: "aabb" + "00".repeat(30), eventIndex: 1 }),
        row({ ledgerSequence: 150, transactionHash: "eeff" + "00".repeat(30), eventIndex: 0 }),
      ]);
      const result = await store.since("testnet", 100);
      assert.equal(result.length, 4);
      assert.equal(result[0].ledgerSequence, 100);
      assert.equal(result[0].eventIndex, 0);
      assert.equal(result[1].eventIndex, 1);
      assert.equal(result[2].ledgerSequence, 150);
      assert.equal(result[3].ledgerSequence, 200);
    } finally {
      store.close();
      cleanup();
    }
  });

  test(`${kind}: since with fromLedger past high water returns empty`, async () => {
    const { store, cleanup } = makeStore(kind);
    try {
      await store.upsert([row({ ledgerSequence: 50 })]);
      const result = await store.since("testnet", 100);
      assert.equal(result.length, 0);
    } finally {
      store.close();
      cleanup();
    }
  });

  test(`${kind}: since only returns events for the requested network`, async () => {
    const { store, cleanup } = makeStore(kind);
    try {
      await store.upsert([
        row({ network: "testnet", ledgerSequence: 100 }),
        row({ network: "pubnet", ledgerSequence: 100 }),
      ]);
      const result = await store.since("testnet", 1);
      assert.equal(result.length, 1);
      assert.equal(result[0].network, "testnet");
    } finally {
      store.close();
      cleanup();
    }
  });

  test(`${kind}: highWater returns max ledger sequence`, async () => {
    const { store, cleanup } = makeStore(kind);
    try {
      await store.upsert([
        row({ ledgerSequence: 100, transactionHash: "aa" + "00".repeat(31), eventIndex: 0 }),
        row({ ledgerSequence: 300, transactionHash: "bb" + "00".repeat(31), eventIndex: 0 }),
        row({ ledgerSequence: 200, transactionHash: "cc" + "00".repeat(31), eventIndex: 0 }),
      ]);
      const hw = await store.highWater("testnet");
      assert.equal(hw, 300);
    } finally {
      store.close();
      cleanup();
    }
  });

  test(`${kind}: highWater returns 0 when no events`, async () => {
    const { store, cleanup } = makeStore(kind);
    try {
      assert.equal(await store.highWater("testnet"), 0);
    } finally {
      store.close();
      cleanup();
    }
  });

  test(`${kind}: byContract filters by contract ID`, async () => {
    const { store, cleanup } = makeStore(kind);
    try {
      await store.upsert([
        row({ contractId: "CONTRACT_A", ledgerSequence: 100, transactionHash: "aa" + "00".repeat(31) }),
        row({ contractId: "CONTRACT_B", ledgerSequence: 100, transactionHash: "bb" + "00".repeat(31) }),
        row({ contractId: "CONTRACT_A", ledgerSequence: 200, transactionHash: "cc" + "00".repeat(31) }),
      ]);
      const result = await store.byContract("CONTRACT_A");
      assert.equal(result.length, 2);
      assert.ok(result.every((r) => r.contractId === "CONTRACT_A"));
      assert.equal(result[0].ledgerSequence, 100);
      assert.equal(result[1].ledgerSequence, 200);
    } finally {
      store.close();
      cleanup();
    }
  });
}

// ─── SQLite-specific tests ─────────────────────────────────────────────────────

test("sqlite: data persists across close/reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-events-"));
  const path = join(dir, "events.sqlite");
  try {
    let store: SqliteEventStore | undefined;
    try {
      store = new SqliteEventStore(path);
      await store.upsert([row({ ledgerSequence: 500 })]);
    } finally {
      store?.close();
    }
    store = new SqliteEventStore(path);
    try {
      const hw = await store.highWater("testnet");
      assert.equal(hw, 500);
      const events = await store.since("testnet", 1);
      assert.equal(events.length, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("sqlite: schema version mismatch is refused on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-events-"));
  const path = join(dir, "bad-schema.sqlite");
  try {
    // Write a database with the wrong schema version.
    const db = new Database(path);
    db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    db.prepare("INSERT INTO schema_version VALUES (?)").run(99);
    db.close();
    assert.throws(() => new SqliteEventStore(path), /Unsupported event store schema/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStore(kind: "memory" | "sqlite"): {
  store: EventStore;
  cleanup: () => void;
} {
  if (kind === "memory") {
    return { store: new MemoryEventStore(), cleanup: () => {} };
  }
  const dir = mkdtempSync(join(tmpdir(), "x402-events-"));
  const path = join(dir, "events.sqlite");
  const store = new SqliteEventStore(path);
  return { store, cleanup: () => rmSync(dir, { recursive: true }) };
}
