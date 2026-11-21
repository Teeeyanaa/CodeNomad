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

describe("trader calibrated fair-value: uncertainty bounds and edge gating", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trader-calib-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeAgent(overrides: Record<string, unknown> = {}) {
    const ledger = makeLedger(dir);
    let submits = 0;
    const agent = new TraderAgent({
      ledger,
      submit: async (): Promise<SubmitResult> => {
        submits += 1;
        return { hash: `tx-${submits}` };
      },
      read: async () => ({ status: "success" }),
      ...overrides,
    });
    return { agent, ledger, submits: () => submits };
  }

  it("rejects stale fair-value inputs before proposing a trade", async () => {
    const { agent, submits } = makeAgent({
      now: () => 1_000_000,
      maxFairValueAgeMs: 5_000,
      minEdgeBps: 10,
      feeBps: 5,
    });
    const estimate = {
      fairValue: 1.0,
      confidence: 0.9,
      observedAt: 1_000_000 - 60_000, // 60s old, well past 5s freshness window
    };
    const decision = await agent.proposeTrade({
      id: "intent-stale",
      action: "swap",
      amount: "10",
      marketPrice: 0.9,
      estimate,
    });
    expect(decision.proposed).toBe(false);
    expect(decision.reason).toMatch(/stale/i);
    expect(submits()).toBe(0);
  });

  it("treats zero confidence as maximum uncertainty and blocks the trade", async () => {
    const { agent, submits } = makeAgent({
      now: () => 1_000_000,
      maxFairValueAgeMs: 5_000,
      minEdgeBps: 10,
      feeBps: 5,
    });
    const decision = await agent.proposeTrade({
      id: "intent-lowconf",
      action: "swap",
      amount: "10",
      marketPrice: 0.5,
      estimate: { fairValue: 1.0, confidence: 0, observedAt: 1_000_000 },
    });
    expect(decision.proposed).toBe(false);
    expect(decision.reason).toMatch(/confidence|uncertainty/i);
    expect(submits()).toBe(0);
  });

  it("treats full confidence as zero uncertainty and allows a clear edge", async () => {
    const { agent } = makeAgent({
      now: () => 1_000_000,
      maxFairValueAgeMs: 5_000,
      minEdgeBps: 10,
      feeBps: 5,
    });
    const decision = await agent.proposeTrade({
      id: "intent-highconf",
      action: "swap",
      amount: "10",
      marketPrice: 0.5,
      estimate: { fairValue: 1.0, confidence: 1, observedAt: 1_000_000 },
    });
    expect(decision.proposed).toBe(true);
    expect(decision.edgeBps).toBeGreaterThan(10);
  });

  it("requires edge after uncertainty and fees, not just raw edge", async () => {
    const { agent } = makeAgent({
      now: () => 1_000_000,
      maxFairValueAgeMs: 5_000,
      minEdgeBps: 50,
      feeBps: 30,
    });
    // Raw edge is 100bps but confidence 0.5 widens the uncertainty band so the
    // conservative edge after uncertainty and fees falls below the minimum.
    const decision = await agent.proposeTrade({
      id: "intent-thin",
      action: "swap",
      amount: "10",
      marketPrice: 0.99,
      estimate: { fairValue: 1.0, confidence: 0.5, observedAt: 1_000_000 },
    });
    expect(decision.proposed).toBe(false);
    expect(decision.reason).toMatch(/edge/i);
  });

  it("clamps probability boundaries at 0 and 1", async () => {
    const { agent } = makeAgent({
      now: () => 1_000_000,
      maxFairValueAgeMs: 5_000,
      minEdgeBps: 10,
      feeBps: 5,
    });
    const low = await agent.proposeTrade({
      id: "intent-low",
      action: "swap",
      amount: "10",
      marketPrice: 0.5,
      estimate: { fairValue: -0.2, confidence: 1, observedAt: 1_000_000 },
    });
    expect(low.fairValue).toBe(0);
    expect(low.proposed).toBe(false);

    const high = await agent.proposeTrade({
      id: "intent-high",
      action: "swap",
      amount: "10",
      marketPrice: 0.5,
      estimate: { fairValue: 1.7, confidence: 1, observedAt: 1_000_000 },
    });
    expect(high.fairValue).toBe(1);
    expect(high.proposed).toBe(true);
  });
});
