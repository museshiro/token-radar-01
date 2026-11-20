// Token Radar radar-3 (Node 22, standard library only). The program reads the sealed snapshot from
// /input/snapshot.json (or --input <file|dir>), calibrates the model against the snapshot's traded
// tokens and fits the launch odds (lib/validate.ts), scores every pre-token protocol with the model
// in lib/model.ts, writes the ranked board to /output/board.json, and copies this repository's
// dashboard/ and screenshots/ to /output. Last, it writes /output/dossier.json, the summary the
// judge reads, with the vendored make.fun library.
//
// The dashboard is a static page, no framework and no network: dashboard/index.html, dashboard/app.css
// and dashboard/app.js read /output/data.js, which this program writes from the same board. radar-3
// replaces the asserted TVL multiple with a comps curve fitted to the traded tokens, prices below the
// median comp, prints the leave-one-out validation on the board, gives every row a farm / marginal /
// skip verdict from its farm economics, and accounts for all 758 protocols.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, MODEL, parseSnapshot, type ModelConstants } from './lib/model.ts';
import { auditBoard, formatAudit } from './lib/verify.ts';
import { fitCalibration, fitLaunchOdds } from './lib/validate.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
// Calibrate first, from the snapshot alone: the comps curve and its leave-one-out validation, then
// the launch odds. The fitted curve becomes the model's constants, so the board and the page run
// the numbers the snapshot itself produced.
const calibration = fitCalibration(snapshot, MODEL);
const launch = fitLaunchOdds(snapshot);
const model: ModelConstants = {
  ...MODEL,
  curve_intercept: calibration.intercept,
  curve_slope: calibration.slope,
  calibration: calibration.factor,
};
const validation = {
  comps: calibration.comps,
  loo_miss: calibration.looMiss,
  newer_half_miss: calibration.newerHalfMiss,
  newer_half_n: calibration.newerHalfN,
  p25_factor: calibration.p25Factor,
  p75_factor: calibration.p75Factor,
  p10_factor: calibration.p10Factor,
  p90_factor: calibration.p90Factor,
  coverage_2575: calibration.coverage2575,
  coverage_2575_n: calibration.coverage2575N,
  coverage_1090: calibration.coverage1090,
  coverage_1090_n: calibration.coverage1090N,
  launch_accuracy: launch.accuracy,
  launch_correct: launch.correct,
  launch_total: launch.total,
  launch_traded: launch.traded,
  launch_pretoken: launch.preToken,
};
const launchModel = { weights: launch.weights, mean: launch.mean, sd: launch.sd };
const { board, radar } = buildRadar(snapshot, model, validation, launchModel);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}
process.stdout.write(`${formatAudit(auditBoard(board, snapshot.watchlist))}\n`);
process.stdout.write(
  `token radar: calibration from ${calibration.comps} comps: curve log(mcap/mult) = ${calibration.intercept.toFixed(4)} + ${calibration.slope.toFixed(4)} x log(TVL), factor ${calibration.factor.toFixed(3)} (40th percentile)\n` +
    `token radar: validation leave-one-out: typical miss x${calibration.looMiss.toFixed(2)}, newer half x${calibration.newerHalfMiss.toFixed(2)} (n=${calibration.newerHalfN}), P25-P75 holds ${(100 * calibration.coverage2575).toFixed(0)}% (${calibration.coverage2575N}/${calibration.comps}), P10-P90 holds ${(100 * calibration.coverage1090).toFixed(0)}% (${calibration.coverage1090N}/${calibration.comps}), launch odds ${(100 * launch.accuracy).toFixed(1)}% (${launch.correct}/${launch.total})\n`,
);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
