import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraderAgent } from "./trader.js";
import type { LedgerStore } from "../src/ledger.js";

type SubmitResult = { hash: string };

/**
 * Chaos harness for ambiguous transaction outcomes.
 *
 * The trader agent must never perform a duplicate economic action when a
 * submit/read partition, delayed finality, duplicate event, or restart during
 * in-flight work makes the outcome of a transaction ambiguous. These tests
 * inject those faults and assert the ledger + retry logic stays idempotent.
 */

function makeLedger(dir: string): LedgerStore {
  return {
    path: join(dir, "ledger.json"),
    load: () => (existsSync(join(dir, "ledger.json")) ? JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) : { intents: {} }),
    save: (state: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("node:fs").writeFileSync(join(dir, "ledger.json"), JSON.stringify(state));
    },
  } as unknown as LedgerStore;
}

describe("trader chaos: ambiguous transaction outcomes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trader-chaos-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not duplicate economic action when submit succeeds but read fails", async () => {
    const ledger = makeLedger(dir);
    let submits = 0;
    const agent = new TraderAgent({
      ledger,
      submit: async (): Promise<SubmitResult> => {
        submits += 1;
        return { hash: "tx-submit-ok" };
      },
      read: async () => {
        throw new Error("read partition: horizon unreachable");
      },
    });

    const intent = { id: "intent-1", action: "swap", amount: "10" };
    await expect(agent.execute(intent)).rejects.toThrow(/read partition/);
    // Retry after the read partition heals: the intent is already recorded as
    // submitted, so the economic action must not be re-submitted.
    await agent.execute(intent);
    expect(submits).toBe(1);
  });

  it("does not duplicate economic action when read succeeds but submit fails", async () => {
    const ledger = makeLedger(dir);
    let submits = 0;
    const agent = new TraderAgent({
      ledger,
      submit: async (): Promise<SubmitResult> => {
        submits += 1;
        if (submits === 1) throw new Error("submit partition: timeout");
        return { hash: "tx-submit-ok" };
      },
      read: async () => ({ status: "not_found" }),
    });

    const intent = { id: "intent-2", action: "swap", amount: "10" };
    await expect(agent.execute(intent)).rejects.toThrow(/submit partition/);
    await agent.execute(intent);
    expect(submits).toBe(2);
    // Only one economic action should be recorded as committed.
    const state = ledger.load() as { intents: Record<string, { status: string }> };
    expect(state.intents["intent-2"].status).toBe("submitted");
  });

  it("does not duplicate economic action under delayed finality", async () => {
    const ledger = makeLedger(dir);
    let submits = 0;
    let reads = 0;
    const agent = new TraderAgent({
      ledger,
      submit: async (): Promise<SubmitResult> => {
        submits += 1;
        return { hash: "tx-delayed" };
      },
      read: async () => {
        reads += 1;
        // Confirmation lags: first reads report pending, then success.
        return reads < 3 ? { status: "pending" } : { status: "success" };
      },
    });

    const intent = { id: "intent-3", action: "swap", amount: "10" };
    await agent.execute(intent);
    await agent.execute(intent);
    await agent.execute(intent);
    expect(submits).toBe(1);
  });

  it("handles duplicate events idempotently", async () => {
    const ledger = makeLedger(dir);
    let submits = 0;
    const agent = new TraderAgent({
      ledger,
      submit: async (): Promise<SubmitResult> => {
        submits += 1;
        return { hash: "tx-dup" };
      },
      read: async () => ({ status: "success" }),
    });

    const intent = { id: "intent-4", action: "swap", amount: "10" };
    const event = { intentId: "intent-4", hash: "tx-dup", status: "success" };
    await agent.execute(intent);
    await agent.onEvent(event);
    await agent.onEvent(event);
    await agent.onEvent(event);
    expect(submits).toBe(1);
    const state = ledger.load() as { intents: Record<string, { status: string }> };
    expect(state.intents["intent-4"].status).toBe("confirmed");
  });

  it("does not re-execute economic action after restart during in-flight work", async () => {
    const ledger = makeLedger(dir);
    let submits = 0;
    const submit = async (): Promise<SubmitResult> => {
      submits += 1;
      return { hash: "tx-restart" };
    };

    const first = new TraderAgent({
      ledger,
      submit,
      read: async () => {
        throw new Error("crash: process killed mid-flight");
      },
    });
    const intent = { id: "intent-5", action: "swap", amount: "10" };
    await expect(first.execute(intent)).rejects.toThrow(/crash/);

    // Simulate restart: a fresh agent instance loads the persisted ledger.
    const restarted = new TraderAgent({
      ledger,
      submit,
      read: async () => ({ status: "success" }),
    });
    await restarted.execute(intent);
    expect(submits).toBe(1);
  });
});

describe("trader cost-aware edge thresholds", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trader-cost-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a trade whose conservative net edge is non-positive", async () => {
    const ledger = makeLedger(dir);
    let submits = 0;
    const agent = new TraderAgent({
      ledger,
      submit: async (): Promise<SubmitResult> => {
        submits += 1;
        return { hash: "tx-cost-reject" };
      },
      read: async () => ({ status: "success" }),
    });

    // Gross edge is positive but fees + impact + slippage consume it entirely.
    const intent = {
      id: "intent-cost-1",
      action: "swap",
      amount: "10",
      expectedEdge: "0.004",
      costs: { fees: "0.002", impact: "0.001", slippage: "0.001" },
    };
    await expect(agent.execute(intent)).rejects.toThrow(/edge/i);
    expect(submits).toBe(0);
  });

  it("accepts a trade with positive conservative net edge and records the cost breakdown", async () => {
    const ledger = makeLedger(dir);
    let submits = 0;
    const agent = new TraderAgent({
      ledger,
      submit: async (): Promise<SubmitResult> => {
        submits += 1;
        return { hash: "tx-cost-accept" };
      },
      read: async () => ({ status: "success" }),
    });

    const intent = {
      id: "intent-cost-2",
      action: "swap",
      amount: "10",
      expectedEdge: "0.01",
      costs: { fees: "0.002", impact: "0.001", slippage: "0.001" },
    };
    await agent.execute(intent);
    expect(submits).toBe(1);

    const state = ledger.load() as {
      intents: Record<string, { status: string; trace?: { costs?: Record<string, string>; netEdge?: string } }>;
    };
    const trace = state.intents["intent-cost-2"].trace;
    expect(trace?.costs).toEqual({ fees: "0.002", impact: "0.001", slippage: "0.001" });
    expect(trace?.netEdge).toBe("0.006");
  });
});
