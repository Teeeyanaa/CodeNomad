import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  AgentConfigError,
  describeConfig,
  loadAgentConfig,
  MAINNET_OPT_IN,
  NETWORKS,
  parseTunables,
  type ContractsReport,
  type LoadAgentConfigOptions,
  type NetworkProbe,
} from "./config.js";
import {
  BUILTIN_STRATEGIES,
  StrategyConfigError,
  getStrategy,
  listStrategies,
  resolveStrategy,
  validateStrategyConfig,
  type MakerStrategy,
  type StrategyContext,
  type TraderStrategy,
} from "./strategy.js";

// Real StrKeys, derived from fixed seeds so every run is identical.
const keypair = (n: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n));
const contract = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const AGENT = keypair(1);
const MAKER = keypair(2);
const OTHER = keypair(3);

const CONTRACTS = {
  usdc: contract(10),
  market_core: contract(11),
  resolver: contract(12),
  treasury: contract(13),
  reasoning_registry: contract(14),
};

function deployment(overrides: Record<string, unknown> = {}) {
  return { deployer: keypair(9).publicKey(), agent: AGENT.publicKey(), contracts: { ...CONTRACTS }, ...overrides };
}

class FakeProbe implements NetworkProbe {
  calls = 0;
  constructor(
    private readonly served: string = NETWORKS.testnet.passphrase,
    private readonly report: ContractsReport = { missing: [], archived: [] },
  ) {}
  async passphrase(): Promise<string> {
    this.calls++;
    return this.served;
  }
  async contractsExist(): Promise<ContractsReport> {
    this.calls++;
    return this.report;
  }
}

interface Setup extends Partial<LoadAgentConfigOptions> {
  record?: unknown;
}

function load(env: NodeJS.ProcessEnv, s: Setup = {}) {
  const files: Record<string, string> = {};
  const logs: string[] = [];
  return {
    logs,
    files,
    run: () =>
      loadAgentConfig({
        role: "trader",
        argv: [],
        probe: new FakeProbe(),
        readFile: (path) => {
          files[path] = "read";
          return JSON.stringify(s.record ?? deployment());
        },
        log: (m) => logs.push(m),
        ...s,
        env,
      }),
  };
}

async function issuesOf(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AgentConfigError, `expected AgentConfigError, got ${String(err)}`);
    return err.issues;
  }
  assert.fail("expected the config to be rejected");
}

const LIVE = { AGENT_MODE: "live", AGENT_SECRET_KEY: AGENT.secret() };

test("an unset AGENT_MODE defaults to dry-run with documented defaults", async () => {
  const cfg = await load({}).run();
  assert.equal(cfg.mode, "dry-run");
  assert.equal(cfg.network, "testnet");
  assert.equal(cfg.networkPassphrase, NETWORKS.testnet.passphrase);
  assert.equal(cfg.rpcUrl, NETWORKS.testnet.rpcUrl);
  assert.equal(cfg.trading.minEdgeBps, 500);
  assert.equal(cfg.trading.tradeSizeStroops, 100_000_000n);
  assert.deepEqual(cfg.trading.kellyFraction, { numerator: 1n, denominator: 4n });
  assert.equal(cfg.trading.sizingBufferBps, 25);
  assert.equal(cfg.trading.minTradeStroops, 1_000_000n);
  assert.equal(cfg.trading.fairUncertaintyBps, 500);
  assert.equal(cfg.maker.defaultSeedStroops, 1_500_000_000n);
  assert.equal(cfg.events.startLedger, undefined);
  assert.equal(cfg.events.maxBackfillPages, 10);
  assert.equal(cfg.agentSecret, undefined);
  assert.match(cfg.deploymentsFile, /deployments[\\/]testnet\.json$/);
});

test("event backfill configuration is strictly bounded", async () => {
  const cfg = await load({ EVENTS_START_LEDGER: "42", EVENTS_BACKFILL_MAX_PAGES: "7" }).run();
  assert.equal(cfg.events.startLedger, 42);
  assert.equal(cfg.events.maxBackfillPages, 7);
  const issues = await issuesOf(load({ EVENTS_START_LEDGER: "0", EVENTS_BACKFILL_MAX_PAGES: "1001" }).run());
  assert.ok(issues.some((i) => i.startsWith("EVENTS_START_LEDGER:")));
  assert.ok(issues.some((i) => i.startsWith("EVENTS_BACKFILL_MAX_PAGES:")));
});

test("unknown and empty agent modes are rejected", async () => {
  for (const AGENT_MODE of ["yolo", "Live", "", " dry-run"]) {
    const issues = await issuesOf(load({ AGENT_MODE }).run());
    assert.ok(issues.some((i) => i.startsWith("AGENT_MODE:")), `${JSON.stringify(AGENT_MODE)}: ${issues}`);
  }
});

test("invalid, non-integer and out-of-range numbers fail, all reported together", async () => {
  const issues = await issuesOf(
    load({
      MIN_EDGE_BPS: "",
      CONFIDENCE_THRESHOLD_BPS: "10001",
      SLIPPAGE_BPS: "12.5",
      DEADLINE_SECS: "NaN",
      FAIR_VALUE_BPS: "-1",
      AGENT_STARTUP_PROBE_TIMEOUT_MS: "0x10",
    }).run(),
  );
  for (const name of ["MIN_EDGE_BPS", "CONFIDENCE_THRESHOLD_BPS", "SLIPPAGE_BPS", "DEADLINE_SECS", "FAIR_VALUE_BPS", "AGENT_STARTUP_PROBE_TIMEOUT_MS"]) {
    assert.ok(issues.some((i) => i.startsWith(`${name}:`)), `${name} missing from ${issues.join(" | ")}`);
  }
});

test("invalid stroop amounts fail", async () => {
  const cases: Record<string, string>[] = [
    { TRADE_SIZE_STROOPS: "0" },
    { TRADE_SIZE_STROOPS: "-5" },
    { TRADE_SIZE_STROOPS: "1.5" },
    { TRADE_SIZE_STROOPS: "1e9" },
    { TRADE_SIZE_STROOPS: (1n << 127n).toString() },
    { DEFAULT_SEED_STROOPS: "999999999" },
    { DEFAULT_SEED_STROOPS: "" },
  ];
  for (const env of cases) {
    const [name] = Object.keys(env);
    const issues = await issuesOf(load(env).run());
    assert.ok(issues.some((i) => i.startsWith(`${name}:`)), `${JSON.stringify(env)}: ${issues}`);
  }
  const ok = await load({ TRADE_SIZE_STROOPS: ((1n << 127n) - 1n).toString(), DEFAULT_SEED_STROOPS: "1000000000" }).run();
  assert.equal(ok.maker.defaultSeedStroops, 1_000_000_000n);
});

test("live mode requires a secret", async () => {
  const issues = await issuesOf(load({ AGENT_MODE: "live" }).run());
  assert.ok(issues.some((i) => /TRADER_SECRET_KEY or AGENT_SECRET_KEY/.test(i)), issues.join(" | "));
});

test("a malformed secret is rejected even in dry-run", async () => {
  const issues = await issuesOf(load({ AGENT_SECRET_KEY: "SNOTAKEY" }).run());
  assert.ok(issues.some((i) => i.startsWith("AGENT_SECRET_KEY:")));
});

test("live mode requires the secret to match deployments.agent", async () => {
  const issues = await issuesOf(load({ AGENT_MODE: "live", AGENT_SECRET_KEY: OTHER.secret() }).run());
  assert.ok(issues.some((i) => i.includes(OTHER.publicKey()) && i.includes(AGENT.publicKey())), issues.join(" | "));

  const cfg = await load(LIVE).run();
  assert.equal(cfg.agentAddress, AGENT.publicKey());
  assert.equal(cfg.agentSecret, AGENT.secret());
});

test("a role key must match that role's registered agent", async () => {
  const record = deployment({ agents: { maker: MAKER.publicKey(), trader: OTHER.publicKey() } });
  const cfg = await load({ AGENT_MODE: "live", MAKER_SECRET_KEY: MAKER.secret() }, { role: "maker", record }).run();
  assert.equal(cfg.agentAddress, MAKER.publicKey());

  const issues = await issuesOf(load({ AGENT_MODE: "live", AGENT_SECRET_KEY: AGENT.secret() }, { role: "trader", record }).run());
  assert.ok(issues.some((i) => i.includes("agents.trader")), issues.join(" | "));
});

test("dry-run never carries the secret, even when one is configured", async () => {
  const cfg = await load({ AGENT_SECRET_KEY: AGENT.secret() }).run();
  assert.equal(cfg.agentSecret, undefined);
});

test("an RPC that serves another network's passphrase prevents live startup", async () => {
  const probe = new FakeProbe(NETWORKS.futurenet.passphrase);
  const issues = await issuesOf(load(LIVE, { probe }).run());
  assert.ok(issues.some((i) => i.includes(NETWORKS.futurenet.passphrase)), issues.join(" | "));
});

test("in dry-run a failing probe is a warning, not an error", async () => {
  const probe: NetworkProbe = {
    passphrase: async () => Promise.reject(new Error("connect ECONNREFUSED")),
    contractsExist: async () => ({ missing: [], archived: [] }),
  };
  const { run, logs } = load({}, { probe });
  const cfg = await run();
  assert.equal(cfg.mode, "dry-run");
  assert.ok(logs.some((l) => l.includes("ECONNREFUSED")));
});

test("live mode fails when the RPC cannot be reached", async () => {
  const probe: NetworkProbe = {
    passphrase: async () => Promise.reject(new Error("connect ECONNREFUSED")),
    contractsExist: async () => ({ missing: [], archived: [] }),
  };
  const issues = await issuesOf(load(LIVE, { probe }).run());
  assert.ok(issues.some((i) => i.includes("ECONNREFUSED")), issues.join(" | "));
});

test("built-in strategies are deterministic and registered under stable ids", () => {
  const ids = listStrategies();
  assert.ok(ids.includes("maker.fixed-spread"));
  assert.ok(ids.includes("trader.edge-gated"));
  for (const id of ids) {
    assert.equal(getStrategy(id).id, id);
  }
  assert.equal(BUILTIN_STRATEGIES.length, ids.length);
});

test("unknown strategy ids fail startup validation with a clear message", () => {
  assert.throws(
    () => resolveStrategy("trader", "does-not-exist"),
    (err: unknown) => err instanceof StrategyConfigError && /does-not-exist/.test(err.message),
  );
  assert.throws(
    () => resolveStrategy("maker", "trader.edge-gated"),
    (err: unknown) => err instanceof StrategyConfigError && /maker/.test(err.message),
  );
});

test("strategy parameters are validated at startup", () => {
  const issues = validateStrategyConfig("trader.edge-gated", { minEdgeBps: -1, confidenceThresholdBps: 10_001 });
  assert.ok(issues.some((i) => i.startsWith("minEdgeBps:")), issues.join(" | "));
  assert.ok(issues.some((i) => i.startsWith("confidenceThresholdBps:")), issues.join(" | "));
  assert.deepEqual(validateStrategyConfig("trader.edge-gated", { minEdgeBps: 500 }), []);
});

test("built-in strategies produce identical output for identical input", () => {
  const ctx: StrategyContext = {
    role: "trader",
    now: 1_700_000_000_000,
    fairValueBps: 5_000,
    confidenceBps: 8_000,
    bestBidBps: 4_900,
    bestAskBps: 5_100,
  };
  const trader = getStrategy("trader.edge-gated") as TraderStrategy;
  const a = trader.decide(ctx);
  const b = trader.decide(ctx);
  assert.deepEqual(a, b);

  const maker = getStrategy("maker.fixed-spread") as MakerStrategy;
  const m1 = maker.quote(ctx);
  const m2 = maker.quote(ctx);
  assert.deepEqual(m1, m2);
});
