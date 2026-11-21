import {
  BPS,
  MAX_SETS,
  MathError,
  calcBuy,
  calcSell,
  collateralOutForShares,
  priceYesBps,
} from "./fpmm.js";

const MAX_COLLATERAL = (1n << 127n) - 1n;

export interface PoolView {
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
  setsMinted: bigint;
}

export interface Holdings {
  yes: bigint;
  no: bigint;
}

export interface CapsView {
  maxTrade: bigint;
  maxMarket: bigint;
  marketExposure: bigint;
  maxDaily: bigint;
  dailyUsed: bigint;
  dailyHeadroom?: bigint;
  availableCapital: bigint;
}

export interface Belief {
  fairYesBps: bigint;
  uncertaintyBps: bigint;
}

export interface SizingParams {
  kellyFractionNumerator: bigint;
  kellyFractionDenominator: bigint;
  bufferBps: bigint;
  slippageBps: bigint;
  minTradeStroops: bigint;
}

export type Binding =
  | "impact"
  | "kelly"
  | "max_trade"
  | "max_market"
  | "max_daily"
  | "capital"
  | "max_sets"
  | "portfolio"
  | "dust";

export interface SizingReport {
  inputs: {
    pool: PoolView;
    holdings: Holdings;
    caps: CapsView;
    belief: Belief;
    params: SizingParams;
    effectiveProbabilityBps: bigint;
    targetBps: bigint;
    bankroll: bigint;
  };
  impactC: bigint;
  kellyC: bigint;
  limits: Record<Exclude<Binding, "dust">, bigint>;
  size: bigint;
  binding: Binding;
}

export interface SizedBuy {
  outcome: "Yes" | "No";
  collateralIn: bigint;
  minSharesOut: bigint;
  expectedShares: bigint;
  priceAfterBps: bigint;
  binding: Binding;
  report: SizingReport;
}

export interface SizeBuyResult {
  buy?: SizedBuy;
  report: SizingReport;
}

export interface SizedSell {
  outcome: "Yes" | "No";
  collateralOut: bigint;
  maxSharesIn: bigint;
  expectedSharesIn: bigint;
  priceAfterBps: bigint;
}

/**
 * Portfolio-level view across all open markets. Used to size a proposed trade
 * against total exposure and available capital, in addition to per-market and
 * on-chain limits. All amounts are in collateral stroops.
 */
export interface PortfolioView {
  /** Total collateral currently deployed across all open markets. */
  totalExposure: bigint;
  /** Configured cap on total portfolio exposure across open markets. */
  maxTotalExposure: bigint;
  /** Collateral available to deploy (free capital, not already committed). */
  availableCapital: bigint;
}

/**
 * Records which portfolio-level factor constrained a proposed position, so
 * outcomes are operationally visible. `null` means the factor did not bind.
 */
export interface PortfolioConstraints {
  /** Remaining headroom under the total exposure cap, or null if uncapped. */
  exposureHeadroom: bigint | null;
  /** Capital available to deploy, or null if not provided. */
  availableCapital: bigint | null;
  /** On-chain per-market headroom (maxMarket - marketExposure). */
  onChainHeadroom: bigint;
  /** The factor that ultimately constrained the position. */
  binding: Binding;
}

function orient(pool: PoolView, outcome: "Yes" | "No"): [bigint, bigint] {
  return outcome === "Yes"
    ? [pool.reserveYes, pool.reserveNo]
    : [pool.reserveNo, pool.reserveYes];
}

function validateParams(params: SizingParams): void {
  if (
    params.kellyFractionDenominator <= 0n ||
    params.kellyFractionNumerator <= 0n ||
    params.kellyFractionNumerator > params.kellyFractionDenominator ||
    params.bufferBps < 0n ||
    params.slippageBps < 0n ||
    params.slippageBps > BPS ||
    params.minTradeStroops < 0n
  ) {
    throw new RangeError("invalid sizing parameters");
  }
}

function boundedBelief(
  pool: PoolView,
  belief: Belief,
  outcome: "Yes" | "No",
): { probability: bigint; currentPrice: bigint } {
  if (belief.fairYesBps < 0n || belief.fairYesBps > BPS || belief.uncertaintyBps < 0n) {
    throw new RangeError("belief must be within basis-point bounds");
  }
  const currentYes = priceYesBps(pool.reserveYes, pool.reserveNo);
  const currentPrice = outcome === "Yes" ? currentYes : BPS - currentYes;
  const fair = outcome === "Yes" ? belief.fairYesBps : BPS - belief.fairYesBps;
  const direction = fair >= currentPrice ? 1n : -1n;
  let probability = fair - direction * belief.uncertaintyBps;
  probability = direction > 0n
    ? (probability < currentPrice ? currentPrice : probability)
    : (probability > currentPrice ? currentPrice : probability);
  if (probability < 0n) probability = 0n;
  if (probability > BPS) probability = BPS;
  return { probability, currentPrice };
}

function priceAfterBuy(pool: PoolView, outcome: "Yes" | "No", collateral: bigint): bigint | null {
  if (collateral === 0n) {
    const yesPrice = priceYesBps(pool.reserveYes, pool.reserveNo);
    return outcome === "Yes" ? yesPrice : BPS - yesPrice;
  }
  const [bought, other] = orient(pool, outcome);
  try {
    const quote = calcBuy(bought, other, collateral, pool.feeBps);
    return (quote.newReserveOther * BPS) / (quote.newReserveBought + quote.newReserveOther);
  } catch (error) {
    if (error instanceof MathError) return null;
    throw error;
  }
}

/**
 * For increasing collateral, the rounded-up fee grows by at most one per
 * stroop, so net collateral is non-decreasing. The other reserve therefore
 * increases, the bought reserve (rounded up) never increases, and the
 * floored marginal price is monotone non-decreasing.
 */
export function impactLimit(
  pool: PoolView,
  outcome: "Yes" | "No",
  targetBps: bigint,
  hi: bigint,
): bigint {
  if (targetBps < 0n || targetBps > BPS || hi < 0n) throw new RangeError("invalid impact search bounds");
  let low = 0n;
  let high = hi;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (netAt(pool, outcome, mid) > 0n) high = mid;
    else low = mid + 1n;
  }
  const firstTradable = low;
  if (firstTradable > hi) return 0n;
  const firstPrice = priceAfterBuy(pool, outcome, firstTradable);
  if (firstPrice === null) return 0n;
  if (firstPrice > targetBps) return 0n;
  low = firstTradable;
  high = hi;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const yesPrice = priceAfterBuy(pool, outcome, mid);
    if (yesPrice !== null && yesPrice <= targetBps) low = mid;
    else high = mid - 1n;
  }
  return low;
}

function netAt(pool: PoolView, outcome: "Yes" | "No", collateral: bigint): bigint {
  if (collateral <= 0n) return 0n;
  const [bought, other] = orient(pool, outcome);
  try {
    return calcBuy(bought, other, collateral, pool.feeBps).net;
  } catch (error) {
    if (error instanceof MathError) return 0n;
    throw error;
  }
}

function maxSetsLimit(pool: PoolView, outcome: "Yes" | "No", hi: bigint): bigint {
  if (pool.setsMinted >= MAX_SETS) return 0n;
  const remaining = MAX_SETS - pool.setsMinted;
  let low = 0n;
  let high = hi;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (netAt(pool, outcome, mid) <= remaining) low = mid;
    else high = mid - 1n;
  }
  return low;
}

/**
 * Portfolio-level headroom: the smaller of the remaining total-exposure
 * headroom and the available capital. Returns null when neither is provided
 * (uncapped), preserving the existing per-market behavior.
 */
export function portfolioHeadroom(portfolio?: PortfolioView): bigint | null {
  if (!portfolio) return null;
  if (portfolio.totalExposure < 0n || portfolio.maxTotalExposure < 0n || portfolio.availableCapital < 0n) {
    throw new RangeError("portfolio values must be non-negative");
  }
  const exposureHeadroom =
    portfolio.maxTotalExposure > portfolio.totalExposure
      ? portfolio.maxTotalExposure - portfolio.totalExposure
      : 0n;
  return exposureHeadroom < portfolio.availableCapital
    ? exposureHeadroom
    : portfolio.availableCapital;
}

function expectedLogWealth(
  pool: PoolView,
  outcome: "Yes" | "No",
  holdings: Holdings,
  probabilityBps: bigint,
  bankroll: bigint,
  collateral: bigint,
): number {
  const [bought, other] = orient(pool, outcome);
  const heldBought = outcome === "Yes" ? holdings.yes : holdings.no;
  const heldOther = outcome === "Yes" ? holdings.no : holdings.yes;
  let shares = 0n;
  if (collateral > 0n) {
    try {
      shares = calcBuy(bought, other, collateral, pool.feeBps).sharesOut;
    } catch (error) {
      if (error instanceof MathError) return Number.NEGATIVE_INFINITY;
      throw error;
    }
  }
  const wealthBought = bankroll - collateral + heldBought + shares;
  const wealthOther = bankroll - collateral + heldOther;
  if (bankroll <= 0n) return Number.NEGATIVE_INFINITY;
  const q = Number(probabilityBps) / Number(BPS);
  let value = 0;
  if (probabilityBps > 0n) {
    if (wealthBought <= 0n) return Number.NEGATIVE_INFINITY;
    value += q * Math.log(Number(wealthBought) / Number(bankroll));
  }
  if (probabilityBps < BPS) {
    if (wealthOther <= 0n) return Number.NEGATIVE_INFINITY;
    value += (1 - q) * Math.log(Number(wealthOther) / Number(bankroll));
  }
  return value;
}

function kellyOptimum(
  pool: PoolView,
  outcome: "Yes" | "No",
  holdings: Holdings,
  probabilityBps: bigint,
  bankroll: bigint,
  hi: bigint,
): bigint {
  if (hi <= 0n || bankroll <= 0n) return 0n;
  let low = 0n;
  let high = hi;
  while (high - low > 8n) {
    const third = (high - low) / 3n;
    const m1 = low + third;
    const m2 = high - third;
    const g1 = expectedLogWealth(pool, outcome, holdings, probabilityBps, bankroll, m1);
    const g2 = expectedLogWealth(pool, outcome, holdings, probabilityBps, bankroll, m2);
    if (g1 < g2) low = m1 + 1n;
    else high = m2 - 1n;
  }
  let best = low;
  let bestValue = expectedLogWealth(pool, outcome, holdings, probabilityBps, bankroll, low);
  for (let candidate = low + 1n; candidate <= high; candidate += 1n) {
    const value = expectedLogWealth(pool, outcome, holdings, probabilityBps, bankroll, candidate);
    if (value > bestValue) {
      best = candidate;
      bestValue = value;
    }
  }
  return best;
}

export function sizeBuyDetailed(
  pool: PoolView,
  holdings: Holdings,
  caps: CapsView,
  belief: Belief,
  params: SizingParams,
  portfolio?: PortfolioView,
): SizeBuyResult {
  validateParams(params);
  const { probability, currentPrice } = boundedBelief(pool, belief, "Yes");
  const targetBps = currentPrice + params.bufferBps;
  const bankroll = caps.availableCapital;

  const marketHeadroom =
    caps.maxMarket > caps.marketExposure ? caps.maxMarket - caps.marketExposure : 0n;
  const dailyHeadroom =
    caps.dailyHeadroom !== undefined
      ? caps.dailyHeadroom
      : caps.maxDaily > caps.dailyUsed
        ? caps.maxDaily - caps.dailyUsed
        : 0n;
  const portfolioCap = portfolioHeadroom(portfolio);

  const limits: Record<Exclude<Binding, "dust">, bigint> = {
    impact: 0n,
    kelly: 0n,
    max_trade: caps.maxTrade < 0n ? 0n : caps.maxTrade,
    max_market: marketHeadroom,
    max_daily: dailyHeadroom,
    capital: caps.availableCapital < 0n ? 0n : caps.availableCapital,
    max_sets: 0n,
    portfolio: portfolioCap === null ? MAX_COLLATERAL : portfolioCap,
  };

  const hi = limits.max_trade < limits.max_market ? limits.max_trade : limits.max_market;
  const hi2 = hi < limits.max_daily ? hi : limits.max_daily;
  const hi3 = hi2 < limits.capital ? hi2 : limits.capital;
  const hi4 = hi3 < limits.portfolio ? hi3 : limits.portfolio;

  limits.impact = impactLimit(pool, "Yes", targetBps, hi4);
  limits.max_sets = maxSetsLimit(pool, "Yes", hi4);
  limits.kelly = kellyOptimum(pool, "Yes", holdings, probability, bankroll, hi4);

  let size = hi4;
  let binding: Binding = "max_trade";
  const order: Array<[Binding, bigint]> = [
    ["max_trade", limits.max_trade],
    ["max_market", limits.max_market],
    ["max_daily", limits.max_daily],
    ["capital", limits.capital],
    ["portfolio", limits.portfolio],
    ["impact", limits.impact],
    ["max_sets", limits.max_sets],
    ["kelly", limits.kelly],
  ];
  for (const [name, value] of order) {
    if (value < size) {
      size = value;
      binding = name;
    }
  }

  const report: SizingReport = {
    inputs: {
      pool,
      holdings,
      caps,
      belief,
      params,
      effectiveProbabilityBps: probability,
      targetBps,
      bankroll,
    },
    impactC: limits.impact,
    kellyC: limits.kelly,
    limits,
    size,
    binding,
  };

  if (size < params.minTradeStroops || size <= 0n) {
    return { report: { ...report, binding: "dust" } };
  }

  const [bought, other] = orient(pool, "Yes");
  const quote = calcBuy(bought, other, size, pool.feeBps);
  const priceAfterBps = (quote.newReserveOther * BPS) / (quote.newReserveBought + quote.newReserveOther);
  const minSharesOut = (quote.sharesOut * (BPS - params.slippageBps)) / BPS;

  return {
    buy: {
      outcome: "Yes",
      collateralIn: size,
      minSharesOut,
      expectedShares: quote.sharesOut,
      priceAfterBps,
      binding,
      report,
    },
    report,
  };
}

/**
 * Records which portfolio-level factor constrained a proposed position.
 * Exposed so callers can surface operational outcomes without re-deriving
 * the binding factor from the report.
 */
export function describePortfolioConstraints(
  caps: CapsView,
  portfolio?: PortfolioView,
): PortfolioConstraints {
  const onChainHeadroom =
    caps.maxMarket > caps.marketExposure ? caps.maxMarket - caps.marketExposure : 0n;
  const exposureHeadroom = portfolio
    ? portfolio.maxTotalExposure > portfolio.totalExposure
      ? portfolio.maxTotalExposure - portfolio.totalExposure
      : 0n
    : null;
  const availableCapital = portfolio ? portfolio.availableCapital : null;

  let binding: Binding = "max_market";
  let smallest = onChainHeadroom;
  if (exposureHeadroom !== null && exposureHeadroom < smallest) {
    smallest = exposureHeadroom;
    binding = "portfolio";
  }
  if (availableCapital !== null && availableCapital < smallest) {
    smallest = availableCapital;
    binding = "capital";
  }
  return { exposureHeadroom, availableCapital, onChainHeadroom, binding };
}
