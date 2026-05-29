// Perf regression sweep for the CLI parity work (3.13.2 → 3.14.0).
//
// Compares wall-clock between a baseline dist (`MG_BASELINE_DIST` env)
// and HEAD (`./dist`). For each scenario: build identical state on both
// instances from cold, run the measured op N times after a warmup phase,
// take median. Surfaces under test cover only what changed in this release.
//
// Run (one-off vs the published baseline):
//   git worktree add /tmp/mg-baseline v3.13.2
//   (cd /tmp/mg-baseline && pnpm install --frozen-lockfile && npm run build)
//   MG_BASELINE_DIST=/tmp/mg-baseline/dist/index.js \
//     node benchmarks/parity-perf.mjs

import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = process.env.MG_BASELINE_DIST
    || (() => { throw new Error('Set MG_BASELINE_DIST to the baseline dist/index.js path'); })();
const HEAD = resolve(HERE, '..', 'dist', 'index.js');

const ITERS = 9;
const WARMUP = 3;
const median = (a) => { const s=[...a].sort((x,y)=>x-y); return s.length%2?s[s.length>>1]:(s[(s.length>>1)-1]+s[s.length>>1])/2; };
const time = async (fn) => { const t=performance.now(); await fn(); return performance.now()-t; };

async function loadMG(distPath) {
    const { MemoryGit } = await import(distPath);
    return MemoryGit;
}

const ME = { name: 'T', email: 't@t', timestamp: 1700000000, timezoneOffset: 0 };
const A = { author: { ...ME }, committer: { ...ME } };

// ---------- builders (shared shape across baseline + HEAD) ----------
async function buildLinear(MG, depth) {
    const mg = new MG('lin');
    mg.setAuthor('T','t@t'); await mg.init();
    for (let i = 0; i < depth; i++) {
        await mg.writeFile('a', String(i));
        await mg.add('.');
        await mg.commit('c' + i, A);
    }
    return mg;
}

async function buildMergeDAG(MG, sideDepth) {
    // root → main-c1..N → merge ; root → side-s1..N → merge
    const mg = new MG('mdag');
    mg.setAuthor('T','t@t'); await mg.init();
    await mg.writeFile('a','0'); await mg.add('.'); await mg.commit('r', A);
    await mg.exec('branch side');
    for (let i = 0; i < sideDepth; i++) {
        await mg.writeFile('a', String(i+1)); await mg.add('.'); await mg.commit('m' + i, A);
    }
    await mg.exec('checkout side');
    for (let i = 0; i < sideDepth; i++) {
        await mg.writeFile('b', String(i)); await mg.add('.'); await mg.commit('s' + i, A);
    }
    await mg.exec('checkout main');
    await mg.merge('side', { noFastForward: true, message: 'merge', ...A });
    return mg;
}

async function buildDiffPair(MG, filesChanged, linesPerFile) {
    // c1: N files each `linesPerFile` lines. c2: rewrite half the lines in each.
    const mg = new MG('dp');
    mg.setAuthor('T','t@t'); await mg.init();
    for (let i = 0; i < filesChanged; i++) {
        const lines = Array.from({length: linesPerFile}, (_,j) => `f${i}_l${j}`).join('\n') + '\n';
        await mg.writeFile(`f${i}.txt`, lines);
    }
    await mg.add('.');
    const c1 = await mg.commit('c1', A);
    for (let i = 0; i < filesChanged; i++) {
        const lines = Array.from({length: linesPerFile}, (_,j) => j % 2 === 0 ? `f${i}_l${j}` : `f${i}_L${j}`).join('\n') + '\n';
        await mg.writeFile(`f${i}.txt`, lines);
    }
    await mg.add('.');
    await mg.commit('c2', A);
    return { mg, c1 };
}

// ---------- measured scenarios ----------
async function scenarioLogDeep(MG) {
    const mg = await buildLinear(MG, 500);
    const runs = [];
    for (let i = 0; i < WARMUP; i++) await mg.log({ depth: 500 });
    for (let i = 0; i < ITERS; i++) runs.push(await time(() => mg.log({ depth: 500 })));
    return median(runs);
}

async function scenarioRevListSingleRef(MG) {
    const mg = await buildMergeDAG(MG, 50);
    const runs = [];
    for (let i = 0; i < WARMUP; i++) await mg.revList({ ref: 'HEAD' });
    for (let i = 0; i < ITERS; i++) runs.push(await time(() => mg.revList({ ref: 'HEAD' })));
    return median(runs);
}

async function scenarioRevListAll(MG) {
    const mg = await buildMergeDAG(MG, 50);
    // Add a tag tip so --all has more seed work.
    await mg.exec('tag -a v1 -m anno');
    const runs = [];
    for (let i = 0; i < WARMUP; i++) await mg.revList({ all: true });
    for (let i = 0; i < ITERS; i++) runs.push(await time(() => mg.revList({ all: true })));
    return median(runs);
}

async function scenarioDescribeMerge(MG) {
    const mg = await buildMergeDAG(MG, 50);
    // Tag a commit early enough that BFS traverses through the merge.
    const oids = await mg.revList({ ref: 'HEAD' });
    await mg.exec(`tag -a v1 -m anno ${oids[oids.length - 3]}`);
    if (!mg.describe) return null; // baseline doesn't have describe yet
    const runs = [];
    for (let i = 0; i < WARMUP; i++) await mg.describe('HEAD');
    for (let i = 0; i < ITERS; i++) runs.push(await time(() => mg.describe('HEAD')));
    return median(runs);
}

async function scenarioDiffLegacy(MG) {
    // Apples-to-apples: legacy human-summary diffText path. Available on
    // both baseline and HEAD, exercises only the tree-walk for the changed-
    // file list (no blob reads, no hunk generation).
    const { mg, c1 } = await buildDiffPair(MG, 20, 50);
    if (!mg.diffText) return null;
    const opts = { fromRef: c1, toRef: 'HEAD' }; // no unified / stat flags
    const runs = [];
    for (let i = 0; i < WARMUP; i++) await mg.diffText(opts);
    for (let i = 0; i < ITERS; i++) runs.push(await time(() => mg.diffText(opts)));
    return median(runs);
}

async function scenarioDiffUnifiedCost(MG) {
    // Self-vs-self on HEAD: how expensive is the new unified path? On the
    // baseline diffText accepts `unified:true` as a no-op (returns the
    // legacy summary), so we detect "really does unified" by checking the
    // output for the `diff --git` header — skip if absent so the comparison
    // doesn't look like a regression.
    const { mg, c1 } = await buildDiffPair(MG, 20, 50);
    if (!mg.diffText) return null;
    const opts = { fromRef: c1, toRef: 'HEAD', unified: true };
    let probe;
    try { probe = await mg.diffText(opts); } catch { return null; }
    if (!probe.includes('diff --git')) return null;
    const runs = [];
    for (let i = 0; i < WARMUP; i++) await mg.diffText(opts);
    for (let i = 0; i < ITERS; i++) runs.push(await time(() => mg.diffText(opts)));
    return median(runs);
}

async function scenarioDiffStatCost(MG) {
    const { mg, c1 } = await buildDiffPair(MG, 20, 50);
    if (!mg.diffText) return null;
    const opts = { fromRef: c1, toRef: 'HEAD', stat: true };
    let probe;
    try { probe = await mg.diffText(opts); } catch { return null; }
    // Native `git diff --stat` output ends with a "<N> file[s] changed,…" line.
    if (!/\d+ files? changed/.test(probe)) return null;
    const runs = [];
    for (let i = 0; i < WARMUP; i++) await mg.diffText(opts);
    for (let i = 0; i < ITERS; i++) runs.push(await time(() => mg.diffText(opts)));
    return median(runs);
}

const scenarios = {
    'log on 500-deep linear': scenarioLogDeep,
    'revList ref on merge DAG (101 commits)': scenarioRevListSingleRef,
    'revList --all (101 commits + tag)': scenarioRevListAll,
    'describe HEAD on merge DAG': scenarioDescribeMerge,
    // Apples-to-apples: the legacy diffText path that both versions support.
    'diff legacy summary (20 files × 50 lines)': scenarioDiffLegacy,
    // Cost reports (new features, no baseline equivalent — printed as info).
    'diff UNIFIED cost (HEAD only)': scenarioDiffUnifiedCost,
    'diff --stat cost (HEAD only)': scenarioDiffStatCost,
};

console.log(`baseline: ${BASELINE}`);
console.log(`head    : ${HEAD}`);
console.log('');
console.log('label                                              base(ms)  head(ms)   Δ%   verdict');
console.log('-'.repeat(95));
for (const [label, fn] of Object.entries(scenarios)) {
    const MGbase = await loadMG(BASELINE);
    const baseRes = await fn(MGbase);
    const MGhead = await loadMG(HEAD);
    const headRes = await fn(MGhead);
    if (baseRes === null || headRes === null) {
        console.log(`${label.padEnd(50)} ${(baseRes === null ? '(not in baseline)' : '(not on head)').padStart(43)}`);
        continue;
    }
    const baseMs = typeof baseRes === 'number' ? baseRes : baseRes.ms;
    const headMs = typeof headRes === 'number' ? headRes : headRes.ms;
    const baseTag = typeof baseRes === 'object' && baseRes.useUnified === false ? ' (legacy)' : '';
    const headTag = typeof headRes === 'object' && headRes.useUnified === false ? ' (legacy)' : '';
    const delta = ((headMs - baseMs) / baseMs) * 100;
    const verdict = delta < -5 ? 'faster' : delta > 5 ? 'SLOWER' : 'flat';
    console.log(`${label.padEnd(50)} ${baseMs.toFixed(1).padStart(8)}${baseTag.padEnd(0)}  ${headMs.toFixed(1).padStart(8)}${headTag.padEnd(0)}  ${delta.toFixed(1).padStart(5)}%  ${verdict}`);
}
