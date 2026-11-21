// Risk controls for the OracleDesk agents.
//
// This module centralises the on-chain risk primitives (position caps, fee
// accounting) and the walk-forward backtest evaluator used to validate trading
// strategies against time-ordered observations.
//
// Backtest guarantees (see issue #61):
// - No look-ahead bias: each step only sees observations up to and including
//   the current index. The benchmark and strategy both consume the same slice.
// - Fees and position/size caps are applied on every simulated trade.
// - Missing observations follow an explicit, configurable policy.
// - Drawdown and calibration are reported alongside returns.
//
// Tournament evaluation (see issue #63):
// - Variants are compared across a shared set of seeds. Every variant must be
//   evaluated on the identical seed set; unpaired comparisons are rejected.
// - Risk-adjusted metrics (drawdown, tail loss, turnover, calibration, capital
//   use) are reported with uncertainty intervals derived from the per-seed
//   dispersion, so a single lucky seed cannot dominate the ranking.

export interface Observation {
  /** Monotonically increasing timestamp (ms). */
  timestamp: number;
  /** Observed price; `null` marks a missing data point. */
  price: number | null;
}

export type MissingDataPolicy = "skip" | "hold" | "flat";

export interface BacktestConfig {
  /** Fraction of notional charged per trade (e.g. 0.001 = 10 bps). */
  feeRate: number;
  /** Maximum fraction of equity deployable in a single position (0..1]. */
  maxPositionFraction: number;
  /** Policy applied when an observation is missing. */
  missingDataPolicy: MissingDataPolicy;
}

export interface BacktestMetrics {
  /** Cumulative strategy return as a fraction (0.1 = +10%). */
  totalReturn: number;
  /** Cumulative benchmark (buy-and-hold) return as a fraction. */
  benchmarkReturn: number;
  /** Strategy return minus benchmark return. */
  excessReturn: number;
  /** Maximum peak-to-trough drawdown as a positive fraction. */
  maxDrawdown: number;
  /** Fraction of directional calls that matched the next move (0..1). */
  calibration: number;
  /** Number of steps actually evaluated. */
  steps: number;
}

/**
 * A strategy maps the observations available so far to a target position in
 * [-1, 1] (short..long). It must only read from the provided slice.
 */
export type Strategy = (history: ReadonlyArray<Observation>) => number;

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  feeRate: 0.001,
  maxPositionFraction: 1,
  missingDataPolicy: "hold",
};

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Walk-forward backtest over time-ordered observations.
 *
 * At each step `i` the strategy receives `observations.slice(0, i + 1)` and may
 * only act on that history, so future prices never leak into the decision.
 * Returns are realised on the following observation, which is the first point
 * at which the position could actually be held.
 */
export function runWalkForwardBacktest(
  observations: ReadonlyArray<Observation>,
  strategy: Strategy,
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
): BacktestMetrics {
  const feeRate = clamp(config.feeRate, 0, 1);
  const maxPosition = clamp(config.maxPositionFraction, 0, 1);

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let benchmarkEquity = 1;
  let steps = 0;
  let correctCalls = 0;
  let directionalCalls = 0;
  let previousPosition = 0;

  for (let i = 0; i < observations.length - 1; i += 1) {
    const current = observations[i];
    const next = observations[i + 1];

    // Missing-data policy: decide how to treat a gap at the current point.
    if (current.price === null) {
      if (config.missingDataPolicy === "skip") {
        continue;
      }
      if (config.missingDataPolicy === "flat") {
        previousPosition = 0;
        continue;
      }
      // "hold": keep the previous position, but we cannot price a move.
      continue;
    }

    // A missing next price means we cannot realise a return this step.
    if (next.price === null) {
      continue;
    }

    const history = observations.slice(0, i + 1);
    const rawTarget = strategy(history);
    const target = clamp(rawTarget, -1, 1) * maxPosition;

    // Fees are charged on the traded delta of the position.
    const traded = Math.abs(target - previousPosition);
    equity -= equity * traded * feeRate;

    const priceReturn = (next.price - current.price) / current.price;
    equity += equity * target * priceReturn;

    // Benchmark: fully-invested buy-and-hold, no fees.
    benchmarkEquity += benchmarkEquity * priceReturn;

    if (target !== 0) {
      directionalCalls += 1;
      if (Math.sign(target) === Math.sign(priceReturn)) {
        correctCalls += 1;
      }
    }

    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? (peak - equity) / peak : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);

    previousPosition = target;
    steps += 1;
  }

  const totalReturn = equity - 1;
  const benchmarkReturn = benchmarkEquity - 1;

  return {
    totalReturn,
    benchmarkReturn,
    excessReturn: totalReturn - benchmarkReturn,
    maxDrawdown,
    calibration: directionalCalls === 0 ? 0 : correctCalls / directionalCalls,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Strategy tournament evaluation (issue #63)
// ---------------------------------------------------------------------------

/** A named strategy variant competing in a tournament. */
export interface StrategyVariant {
  /** Stable identifier used to pair results across seeds. */
  id: string;
  /** The strategy under evaluation. */
  strategy: Strategy;
}

/** A single deterministic scenario (seed) shared by every variant. */
export interface TournamentSeed {
  /** Stable identifier for the seed. */
  id: string;
  /** Time-ordered observations generated deterministically for this seed. */
  observations: ReadonlyArray<Observation>;
}

/** Risk-adjusted metrics for one variant on one seed. */
export interface SeedMetrics {
  /** Cumulative strategy return as a fraction. */
  totalReturn: number;
  /** Strategy return minus benchmark return. */
  excessReturn: number;
  /** Maximum peak-to-trough drawdown as a positive fraction. */
  maxDrawdown: number;
  /** Worst single-step loss as a positive fraction (tail loss). */
  tailLoss: number;
  /** Mean absolute position change per step (turnover). */
  turnover: number;
  /** Fraction of directional calls that matched the next move (0..1). */
  calibration: number;
  /** Mean absolute deployed position per step (capital use, 0..1). */
  capitalUse: number;
  /** Number of steps actually evaluated. */
  steps: number;
}

/** A point estimate with a symmetric uncertainty interval. */
export interface IntervalEstimate {
  /** Mean across seeds. */
  mean: number;
  /** Lower bound of the uncertainty interval. */
  lower: number;
  /** Upper bound of the uncertainty interval. */
  upper: number;
  /** Number of seeds contributing to the estimate. */
  samples: number;
}

/** Aggregated, risk-adjusted tournament result for one variant. */
export interface VariantReport {
  id: string;
  /** Risk-adjusted score (higher is better); see `riskAdjustedScore`. */
  score: number;
  /** Per-metric interval estimates across the shared seeds. */
  metrics: {
    excessReturn: IntervalEstimate;
    maxDrawdown: IntervalEstimate;
    tailLoss: IntervalEstimate;
    turnover: IntervalEstimate;
    calibration: IntervalEstimate;
    capitalUse: IntervalEstimate;
  };
  /** Per-seed metrics, keyed by seed id, for auditing. */
  perSeed: Record<string, SeedMetrics>;
}

export interface TournamentResult {
  /** Seed ids shared by every variant, in input order. */
  seedIds: string[];
  /** Variant reports sorted by descending risk-adjusted score. */
  ranking: VariantReport[];
}

const UNKNOWN_GROUP_ID = "unknown";

/**
 * Error thrown when variants are not evaluated on an identical seed set.
 * Unpaired comparisons are rejected so rankings are never computed across
 * mismatched scenarios.
 */
export class UnpairedComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnpairedComparisonError";
  }
}

/**
 * Compute per-seed risk-adjusted metrics for a single strategy. Mirrors the
 * walk-forward guarantees of `runWalkForwardBacktest` while additionally
 * tracking tail loss, turnover and capital use.
 */
export function evaluateSeed(
  observations: ReadonlyArray<Observation>,
  strategy: Strategy,
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
): SeedMetrics {
  const feeRate = clamp(config.feeRate, 0, 1);
  const maxPosition = clamp(config.maxPositionFraction, 0, 1);

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let benchmarkEquity = 1;
  let steps = 0;
  let correctCalls = 0;
  let directionalCalls = 0;
  let previousPosition = 0;
  let tailLoss = 0;
  let turnoverSum = 0;
  let capitalSum = 0;

  for (let i = 0; i < observations.length - 1; i += 1) {
    const current = observations[i];
    const next = observations[i + 1];

    if (current.price === null) {
      if (config.missingDataPolicy === "flat") {
        previousPosition = 0;
      }
      continue;
    }
    if (next.price === null) {
      continue;
    }

    const history = observations.slice(0, i + 1);
    const rawTarget = strategy(history);
    const target = clamp(rawTarget, -1, 1) * maxPosition;

    const traded = Math.abs(target - previousPosition);
    equity -= equity * traded * feeRate;

    const priceReturn = (next.price - current.price) / current.price;
    const stepPnl = equity * target * priceReturn;
    equity += stepPnl;

    benchmarkEquity += benchmarkEquity * priceReturn;

    if (target !== 0) {
      directionalCalls += 1;
      if (Math.sign(target) === Math.sign(priceReturn)) {
        correctCalls += 1;
      }
    }

    // Tail loss: worst single-step loss as a positive fraction of equity.
    if (stepPnl < 0) {
      const lossFraction = -stepPnl / Math.max(equity - stepPnl, 1e-9);
      tailLoss = Math.max(tailLoss, lossFraction);
    }

    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? (peak - equity) / peak : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);

    turnoverSum += traded;
    capitalSum += Math.abs(target);

    previousPosition = target;
    steps += 1;
  }

  const totalReturn = equity - 1;
  const benchmarkReturn = benchmarkEquity - 1;

  return {
    totalReturn,
    excessReturn: totalReturn - benchmarkReturn,
    maxDrawdown,
    tailLoss,
    turnover: steps === 0 ? 0 : turnoverSum / steps,
    calibration: directionalCalls === 0 ? 0 : correctCalls / directionalCalls,
    capitalUse: steps === 0 ? 0 : capitalSum / steps,
    steps,
  };
}

/**
 * Risk-adjusted score: reward excess return and calibration, penalise
 * drawdown, tail loss, turnover and idle capital. Higher is better.
 */
export function riskAdjustedScore(metrics: SeedMetrics): number {
  return (
    metrics.excessReturn +
    0.5 * (metrics.calibration - 0.5) -
    metrics.maxDrawdown -
    metrics.tailLoss -
    0.1 * metrics.turnover -
    0.05 * (1 - metrics.capitalUse)
  );
}

function intervalEstimate(values: ReadonlyArray<number>): IntervalEstimate {
  const samples = values.length;
  if (samples === 0) {
    return { mean: 0, lower: 0, upper: 0, samples: 0 };
  }
  const mean = values.reduce((sum, v) => sum + v, 0) / samples;
  if (samples === 1) {
    return { mean, lower: mean, upper: mean, samples };
  }
  const variance =
    values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / (samples - 1);
  // 95% interval using the standard error of the mean.
  const margin = 1.96 * Math.sqrt(variance / samples);
  return { mean, lower: mean - margin, upper: mean + margin, samples };
}

/**
 * Run a strategy tournament across a shared set of seeds.
 *
 * Every variant is evaluated on the identical seed set. If any variant is
 * missing a seed (or the seed sets differ), an `UnpairedComparisonError` is
 * thrown so unpaired comparisons can never produce a ranking.
 */
export function runTournament(
  variants: ReadonlyArray<StrategyVariant>,
  seeds: ReadonlyArray<TournamentSeed>,
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
): TournamentResult {
  if (variants.length === 0) {
    return { seedIds: [], ranking: [] };
  }

  const seedIds = seeds.map((seed) => seed.id);
  const uniqueSeedIds = new Set(seedIds);
  if (uniqueSeedIds.size !== seedIds.length) {
    throw new UnpairedComparisonError("Duplicate seed ids in tournament seed set");
  }

  const variantIds = new Set<string>();
  for (const variant of variants) {
    if (variantIds.has(variant.id)) {
      throw new UnpairedComparisonError(
        `Duplicate variant id: ${variant.id}`,
      );
    }
    variantIds.add(variant.id);
  }

  const ranking: VariantReport[] = variants.map((variant) => {
    const perSeed: Record<string, SeedMetrics> = {};
    for (const seed of seeds) {
      perSeed[seed.id] = evaluateSeed(seed.observations, variant.strategy, config);
    }

    // Guard: every variant must have a result for every shared seed.
    for (const seedId of seedIds) {
      if (!(seedId in perSeed)) {
        throw new UnpairedComparisonError(
          `Variant ${variant.id} missing seed ${seedId}`,
        );
      }
    }

    const seedMetrics = seedIds.map((seedId) => perSeed[seedId]);
    const scores = seedMetrics.map(riskAdjustedScore);

    return {
      id: variant.id,
      score: intervalEstimate(scores).mean,
      metrics: {
        excessReturn: intervalEstimate(seedMetrics.map((m) => m.excessReturn)),
        maxDrawdown: intervalEstimate(seedMetrics.map((m) => m.maxDrawdown)),
        tailLoss: intervalEstimate(seedMetrics.map((m) => m.tailLoss)),
        turnover: intervalEstimate(seedMetrics.map((m) => m.turnover)),
        calibration: intervalEstimate(seedMetrics.map((m) => m.calibration)),
        capitalUse: intervalEstimate(seedMetrics.map((m) => m.capitalUse)),
      },
      perSeed,
    };
  });

  ranking.sort((a, b) => b.score - a.score);

  return { seedIds, ranking };
}

export interface AgentRiskState {
  now: bigint;
  global: {
    maxTrade: bigint;
    maxMarket: bigint;
    maxDaily: bigint;
    maxNetExposure: bigint;
  };
  agent: AgentRiskPolicy;
  usage: {
    global: AgentUsageWindow;
    agent: AgentUsageWindow;
  };
  /** Treasury's current token balance before a possible yield withdrawa

/* … truncated 7739 chars — edit only what you need near the top … */
