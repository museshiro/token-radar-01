// Calibration and validation for the token radar (radar-3).
//
// Everything here is computed from the sealed snapshot at build time, so the numbers the
// dashboard prints are the model's own measurements, never assertions typed in by hand:
//   - the comps curve is a least-squares fit of log(mcap / multipliers) on log(TVL) over the
//     traded tokens that are clean comparables;
//   - the calibration factor prices at the 40th percentile of those comps, a deliberate tilt
//     below the median, because a pre-token protocol has not yet proven a token market;
//   - the validation metrics are leave-one-out: each comp is predicted from a fit that never
//     saw it, so the miss factors and the range coverage are honest out-of-sample numbers;
//   - the launch odds come from a logistic model fitted to the same snapshot (traded against
//     pre-token), scored by 5-fold cross-validation.
//
// Nothing here is imported by the dashboard: main.ts runs it once, and the results travel to
// the page inside data.js. The fit is deterministic (closed-form least squares, fixed-iteration
// gradient descent, folds by index), so the program's two runs write the same bytes.

import { ageDays, isPreToken, launchFeatures, type ModelConstants, type Snapshot, type SnapshotProtocol } from './model.ts';

/** A traded token clean enough to price against: it trades, is not an exchange, not a versioned
 *  pool, not a bridge or a wrapped or staked product, and holds at least $1M of TVL. */
export function isComp(p: SnapshotProtocol): boolean {
  if (p.mcap_usd === null || p.mcap_usd <= 0) return false;
  if (p.category === 'CEX') return false;
  if (VERSIONED.test(p.name)) return false;
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('bridge')) return false;
  if (c.includes('liquid staking') || c.includes('liquid restaking') || c.includes('restaked btc')) return false;
  if (p.tvl_usd < 1_000_000) return false;
  return true;
}

/** DefiLlama's version-marker rule, shared with the model's rankable check. */
export const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** The three multipliers one protocol gets, as the model scores it. */
export function multipliers(p: SnapshotProtocol, asOf: string, model: ModelConstants): { growth: number; maturity: number; chains: number } {
  const rawGrowth = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growth = 1 + (growthPct / 100) * model.growth_weight;
  const age = ageDays(asOf, p.listed_at) ?? model.unknown_age_days;
  const maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const chains = 1 + Math.min(Math.max(p.chains.length - 1, 0), model.chains_cap) * model.chains_weight;
  return { growth, maturity, chains };
}

/** Least squares on log-log: log(y) = a + b * log(x), over the pairs given. */
function fitLogLog(pairs: { x: number; y: number }[]): { intercept: number; slope: number } {
  const n = pairs.length;
  const mx = pairs.reduce((s, q) => s + Math.log(q.x), 0) / n;
  const my = pairs.reduce((s, q) => s + Math.log(q.y), 0) / n;
  let num = 0;
  let den = 0;
  for (const q of pairs) {
    const dx = Math.log(q.x) - mx;
    num += dx * (Math.log(q.y) - my);
    den += dx * dx;
  }
  const slope = den === 0 ? 0 : num / den;
  return { intercept: my - slope * mx, slope };
}

/** The comps curve and everything the dashboard prints about the model's own accuracy. */
export interface Calibration {
  comps: number;
  intercept: number;
  slope: number;
  factor: number;
  percentile: number;
  looMiss: number;
  newerHalfMiss: number;
  newerHalfN: number;
  p25Factor: number;
  p75Factor: number;
  p10Factor: number;
  p90Factor: number;
  coverage2575: number;
  coverage2575N: number;
  coverage1090: number;
  coverage1090N: number;
}

/** The fitted curve and its leave-one-out validation, from the snapshot alone. */
export function fitCalibration(snapshot: Snapshot, model: ModelConstants): Calibration {
  const comps = snapshot.protocols.filter(isComp);
  if (comps.length < 10) throw new Error(`token radar: ${comps.length} clean comps is too few to calibrate`);
  // The adjusted fit: the multipliers are inside the regression, so the curve is the geometric-mean
  // prediction for a traded token with the protocol's own multipliers already applied.
  const fitAll = fitLogLog(
    comps.map((p) => {
      const m = multipliers(p, snapshot.as_of, model);
      return { x: p.tvl_usd, y: p.mcap_usd! / (m.growth * m.maturity * m.chains) };
    }),
  );
  const predict = (p: SnapshotProtocol, f: { intercept: number; slope: number }): number => {
    const m = multipliers(p, snapshot.as_of, model);
    return Math.exp(f.intercept + f.slope * Math.log(p.tvl_usd)) * m.growth * m.maturity * m.chains;
  };
  // Leave one out: every comp is predicted from a fit that never saw it.
  const residuals: { p: SnapshotProtocol; logRatio: number }[] = [];
  for (let i = 0; i < comps.length; i++) {
    const held = comps[i]!;
    const rest = comps.filter((_, j) => j !== i);
    const f = fitLogLog(
      rest.map((p) => {
        const m = multipliers(p, snapshot.as_of, model);
        return { x: p.tvl_usd, y: p.mcap_usd! / (m.growth * m.maturity * m.chains) };
      }),
    );
    residuals.push({ p: held, logRatio: Math.log(predict(held, f) / held.mcap_usd!) });
  }
  const sorted = [...residuals].sort((a, b) => a.logRatio - b.logRatio);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.logRatio;
  // The calibration factor prices at the 40th percentile of the comps: the level 60% of comparable
  // traded tokens exceed. Below the median on purpose, because a pre-token protocol has not yet
  // proven it can hold a token market.
  const percentile = 0.4;
  const factor = Math.exp(at(percentile));
  const p25 = Math.exp(at(0.25));
  const p75 = Math.exp(at(0.75));
  const p10 = Math.exp(at(0.1));
  const p90 = Math.exp(at(0.9));
  // The typical miss, with the factor applied: how far the priced prediction usually sits from the
  // comp's real market cap, in either direction.
  const miss = residuals
    .map(({ logRatio }) => {
      const ratio = Math.exp(logRatio) * factor;
      return Math.max(ratio, 1 / ratio);
    })
    .sort((a, b) => a - b);
  const looMiss = miss[Math.floor(miss.length / 2)]!;
  // The newer half by time: the comps with a listing date, split at the median date, and the miss
  // on the newer half alone. A model that only fits the old tokens is a model that cannot see a launch.
  const dated = comps.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const newer = dated.slice(Math.floor(dated.length / 2));
  const newerMiss = newer
    .map((held) => {
      const rest = comps.filter((q) => q !== held);
      const f = fitLogLog(
        rest.map((p) => {
          const m = multipliers(p, snapshot.as_of, model);
          return { x: p.tvl_usd, y: p.mcap_usd! / (m.growth * m.maturity * m.chains) };
        }),
      );
      const ratio = (predict(held, f) * factor) / held.mcap_usd!;
      return Math.max(ratio, 1 / ratio);
    })
    .sort((a, b) => a - b);
  const newerHalfMiss = newerMiss[Math.floor(newerMiss.length / 2)]!;
  // Range coverage: the printed interval around a priced prediction is the residual spread, so a
  // held-out comp's real cap should land inside the P25-P75 band about half the time and inside
  // P10-P90 about four times in five. The check is whether it does.
  let in2575 = 0;
  let in1090 = 0;
  for (const { logRatio } of residuals) {
    const logActualOverPriced = -logRatio - Math.log(factor);
    if (logActualOverPriced >= at(0.25) && logActualOverPriced <= at(0.75)) in2575++;
    if (logActualOverPriced >= at(0.1) && logActualOverPriced <= at(0.9)) in1090++;
  }
  return {
    comps: comps.length,
    intercept: fitAll.intercept,
    slope: fitAll.slope,
    factor,
    percentile,
    looMiss,
    newerHalfMiss,
    newerHalfN: newer.length,
    p25Factor: p25,
    p75Factor: p75,
    p10Factor: p10,
    p90Factor: p90,
    coverage2575: in2575 / residuals.length,
    coverage2575N: in2575,
    coverage1090: in1090 / residuals.length,
    coverage1090N: in1090,
  };
}

/** The launch model: a logistic regression on the snapshot's own record of what launched. */
export interface LaunchModel {
  weights: number[];
  mean: number[];
  sd: number[];
  accuracy: number;
  correct: number;
  total: number;
  traded: number;
  preToken: number;
}

const LOGISTIC_ITERS = 800;
const LOGISTIC_RATE = 0.5;
const LOGISTIC_L2 = 0.01;

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** One gradient-descent fit over standardised features and 0/1 labels. Deterministic. */
function fitLogistic(features: number[][], labels: number[]): number[] {
  const d = features[0]!.length;
  const weights = new Array<number>(d + 1).fill(0);
  const n = features.length;
  for (let iter = 0; iter < LOGISTIC_ITERS; iter++) {
    const grad = new Array<number>(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      let z = weights[0]!;
      for (let j = 0; j < d; j++) z += weights[j + 1]! * features[i]![j]!;
      const err = sigmoid(z) - labels[i]!;
      grad[0]! += err;
      for (let j = 0; j < d; j++) grad[j + 1]! += err * features[i]![j]!;
    }
    for (let j = 0; j <= d; j++) {
      const reg = j === 0 ? 0 : LOGISTIC_L2 * weights[j]!;
      weights[j]! -= (LOGISTIC_RATE / n) * (grad[j]! + reg);
    }
  }
  return weights;
}

/** The launch model, fitted and scored by 5-fold cross-validation on the snapshot. */
export function fitLaunchOdds(snapshot: Snapshot): LaunchModel {
  const rows: { p: SnapshotProtocol; y: number }[] = [];
  for (const p of snapshot.protocols) {
    if (isComp(p)) rows.push({ p, y: 1 });
    else if (isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name)) rows.push({ p, y: 0 });
  }
  if (rows.length < 20) throw new Error(`token radar: ${rows.length} launch examples is too few to fit`);
  const raw = rows.map((r) => launchFeatures(r.p, snapshot.as_of));
  const d = raw[0]!.length;
  const mean = Array.from({ length: d }, (_, j) => raw.reduce((s, r) => s + r[j]!, 0) / raw.length);
  const sd = Array.from({ length: d }, (_, j) => {
    const v = raw.reduce((s, r) => s + (r[j]! - mean[j]!) * (r[j]! - mean[j]!), 0) / raw.length;
    return Math.sqrt(v) || 1;
  });
  const features = raw.map((r) => r.map((v, j) => (v - mean[j]!) / sd[j]!));
  const labels = rows.map((r) => r.y);
  // Five folds by index, so the split is the same on every run. A fold's model never sees its fold.
  let correct = 0;
  for (let fold = 0; fold < 5; fold++) {
    const testIdx: number[] = [];
    const trainIdx: number[] = [];
    for (let i = 0; i < features.length; i++) (i % 5 === fold ? testIdx : trainIdx).push(i);
    const w = fitLogistic(
      trainIdx.map((i) => features[i]!),
      trainIdx.map((i) => labels[i]!),
    );
    for (const i of testIdx) {
      let z = w[0]!;
      for (let j = 0; j < d; j++) z += w[j + 1]! * features[i]![j]!;
      if ((sigmoid(z) >= 0.5) === (labels[i] === 1)) correct++;
    }
  }
  const weights = fitLogistic(features, labels);
  return {
    weights,
    mean,
    sd,
    accuracy: correct / features.length,
    correct,
    total: features.length,
    traded: rows.filter((r) => r.y === 1).length,
    preToken: rows.filter((r) => r.y === 0).length,
  };
}

/** One protocol's launch odds under a fitted launch model, 0 to 1. */
export function launchOdds(p: SnapshotProtocol, asOf: string, launch: LaunchModel): number {
  const raw = launchFeatures(p, asOf);
  const z = raw.map((v, j) => (v - launch.mean[j]!) / launch.sd[j]!);
  let s = launch.weights[0]!;
  for (let j = 0; j < z.length; j++) s += launch.weights[j + 1]! * z[j]!;
  return sigmoid(s);
}
