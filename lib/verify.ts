// Board audit (radar-2): a second, independent pass over the ranked board before anything is
// written to /output. It does not score or rank; it only asks whether the finished board is
// the board the gate expects, and it prints a short human-readable report so a bad build is
// visible in the build log instead of surfacing later as a rejected submission. The checks
// mirror the competition gate, not the model: ranks, order, coverage, farm plans, and the
// shape of every row. Nothing here changes the board; it only reads it.

import type { BoardRow } from './model.ts';

/** One thing the audit noticed, with a short machine-readable code and a human sentence. */
export interface AuditFinding {
  severity: 'error' | 'warning';
  code: string;
  detail: string;
}

/** The audit's verdict plus the headline numbers a reader wants at a glance. */
export interface AuditReport {
  rows: number;
  findings: AuditFinding[];
  watchlistCovered: number;
  watchlistTotal: number;
  topImpliedUsd: number;
  medianImpliedUsd: number;
  distinctChains: number;
  distinctCategories: number;
  duplicateSlugs: string[];
  biggestCategories: { category: string; rows: number }[];
  largestTvls: { slug: string; tvlUsd: number }[];
}

const MAX_IMPLIED_USD = 100_000_000_000_000;
const MIN_STEP_CHARS = 20;
const MAX_STEP_CHARS = 600;
const MIN_STEPS = 3;
const MAX_STEPS = 12;

function finding(severity: 'error' | 'warning', code: string, detail: string): AuditFinding {
  return { severity, code, detail };
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function biggestCategoriesOf(board: BoardRow[]): { category: string; rows: number }[] {
  const counts = new Map<string, number>();
  for (const row of board) {
    const key = row.category ?? 'Other';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, rows]) => ({ category, rows }))
    .sort((a, b) => b.rows - a.rows || (a.category < b.category ? -1 : 1))
    .slice(0, 3);
}

function largestTvlsOf(board: BoardRow[]): { slug: string; tvlUsd: number }[] {
  return [...board]
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, 3)
    .map((row) => ({ slug: row.slug, tvlUsd: row.tvl_usd }));
}

/** Walk the finished board once, collecting every gate-shaped problem and the headline numbers. */
export function auditBoard(board: BoardRow[], watchlist: string[]): AuditReport {
  const findings: AuditFinding[] = [];
  const seenSlugs = new Set<string>();
  const duplicateSlugs: string[] = [];
  const chains = new Set<string>();
  const categories = new Set<string>();
  let previousImplied = Number.POSITIVE_INFINITY;

  board.forEach((row, index) => {
    if (row.rank !== index + 1) {
      findings.push(finding('error', 'rank-sequence', `row ${index + 1} carries rank ${row.rank}, expected ${index + 1}`));
    }
    if (seenSlugs.has(row.slug)) {
      if (!duplicateSlugs.includes(row.slug)) duplicateSlugs.push(row.slug);
    } else {
      seenSlugs.add(row.slug);
    }
    if (!(row.implied_value_usd > 0)) {
      findings.push(finding('error', 'implied-not-positive', `${row.slug} has implied value ${row.implied_value_usd}`));
    }
    if (row.implied_value_usd > MAX_IMPLIED_USD) {
      findings.push(finding('error', 'implied-over-cap', `${row.slug} has implied value ${row.implied_value_usd}, over the ${MAX_IMPLIED_USD} cap`));
    }
    if (row.implied_value_usd > previousImplied) {
      findings.push(finding('error', 'board-not-sorted', `${row.slug} at rank ${row.rank} is worth more than the row above it`));
    }
    previousImplied = row.implied_value_usd;
    if (row.farm_steps.length < MIN_STEPS || row.farm_steps.length > MAX_STEPS) {
      findings.push(finding('error', 'farm-step-count', `${row.slug} has ${row.farm_steps.length} farm steps, the gate wants ${MIN_STEPS} to ${MAX_STEPS}`));
    }
    row.farm_steps.forEach((step, stepIndex) => {
      const trimmed = step.trim();
      if (trimmed.length < MIN_STEP_CHARS || trimmed.length > MAX_STEP_CHARS) {
        findings.push(finding('error', 'farm-step-length', `${row.slug} step ${stepIndex + 1} is ${trimmed.length} characters after trimming, the gate wants ${MIN_STEP_CHARS} to ${MAX_STEP_CHARS}`));
      }
    });
    row.chains.forEach((chain) => chains.add(chain));
    if (row.category !== null) categories.add(row.category);
  });

  const covered = watchlist.filter((slug) => seenSlugs.has(slug));
  if (covered.length !== watchlist.length) {
    const missing = watchlist.filter((slug) => !seenSlugs.has(slug));
    findings.push(finding('error', 'watchlist-gap', `${missing.length} watchlist slug${missing.length === 1 ? '' : 's'} missing from the board: ${missing.slice(0, 5).join(', ')}`));
  }

  const impliedValues = board.map((row) => row.implied_value_usd);
  return {
    rows: board.length,
    findings,
    watchlistCovered: covered.length,
    watchlistTotal: watchlist.length,
    topImpliedUsd: impliedValues.length === 0 ? 0 : Math.max(...impliedValues),
    medianImpliedUsd: medianOf(impliedValues),
    distinctChains: chains.size,
    distinctCategories: categories.size,
    duplicateSlugs,
    biggestCategories: biggestCategoriesOf(board),
    largestTvls: largestTvlsOf(board),
  };
}

/** The report as it appears in the build log: two headline lines, then one line per finding. */
export function formatAudit(report: AuditReport): string {
  const errors = report.findings.filter((f) => f.severity === 'error').length;
  const warnings = report.findings.length - errors;
  const categoryText = report.biggestCategories.map((c) => `${c.category} ${c.rows}`).join(', ') || 'none';
  const tvlText = report.largestTvls.map((t) => `${t.slug} $${t.tvlUsd.toLocaleString('en-US')}`).join(', ') || 'none';
  const lines = [
    `token radar audit: ${report.rows} rows, watchlist ${report.watchlistCovered}/${report.watchlistTotal}, top implied $${report.topImpliedUsd.toLocaleString('en-US')}, median implied $${report.medianImpliedUsd.toLocaleString('en-US')}`,
    `token radar audit: ${report.distinctChains} chains, ${report.distinctCategories} categories, ${report.duplicateSlugs.length} duplicate slugs, ${errors} errors, ${warnings} warnings`,
    `token radar audit: biggest categories: ${categoryText}; largest TVLs: ${tvlText}`,
  ];
  for (const f of report.findings) lines.push(`token radar audit: [${f.severity}] ${f.code}: ${f.detail}`);
  return lines.join('\n');
}
