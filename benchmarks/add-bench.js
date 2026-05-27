#!/usr/bin/env node
/**
 * add('.') optimization benchmark.
 *
 * Validates the client-side win discussed for the "load repo → build → stage"
 * workflow: replacing `add('.')` with `add(getDirtyPaths())`.
 *
 * Why this matters
 * ----------------
 * After loadFromDisk, MemoryGit seeds EVERY working-tree file into its dirty
 * set (src/index.ts:699-700), so the first `add('.')` re-reads + re-hashes +
 * re-deflates every file — even on a clean checkout whose loaded `.git/index`
 * already matches the worktree. And because build tools write through the fs
 * adapter (`toJustBashFs(mg)` → `mg.volume`, the recording-fs layer), those
 * writes land in `_unpersisted` (what getDirtyPaths() reports) but NOT in
 * `_dirtyFiles` (what `add('.')` reads). Net effect for a build:
 *
 *   add('.')               → O(all files) hashing  AND  misses files the
 *                            build CREATED after load (they're untracked).
 *   add(getDirtyPaths())   → O(changed files)       AND  stages everything the
 *                            build touched, new files included.
 *
 * The library fix (feed _dirtyFiles from the recording-fs + status-based seed)
 * would make `add('.')` itself behave like the second column. This script
 * measures the gap that fix would close, using only the public API as it ships
 * today.
 *
 * Run:
 *   node --expose-gc benchmarks/add-bench.js
 *   MG_FILES=5000 MG_CHANGED=25 MG_NEW=10 node --expose-gc benchmarks/add-bench.js
 *
 * Requires a built dist/ (`npm run build`) and `git` on PATH.
 */

const { MemoryGit } = require('..');
const { execSync } = require('child_process');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const CFG = {
    numFiles: int(process.env.MG_FILES, 2000),   // files committed in the repo
    changed: int(process.env.MG_CHANGED, 20),     // existing files the build modifies
    added: int(process.env.MG_NEW, 5),            // NEW files the build creates
    fileSize: int(process.env.MG_SIZE, 512),      // bytes per file
    iters: int(process.env.MG_ITERS, 5),          // timing repetitions (median reported)
    diskDir: path.join(os.tmpdir(), 'mg-add-bench-repo'),
};

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

const gc = typeof global.gc === 'function' ? () => global.gc() : () => {};
if (typeof global.gc !== 'function') {
    console.warn('⚠  Run with `node --expose-gc` for meaningful heap deltas.\n');
}

function content(size, salt = '') {
    // Cheap pseudo-random-ish payload; salt forces a distinct blob (new OID).
    const base = 'abcdefghijklmnopqrstuvwxyz0123456789\n';
    let s = salt;
    while (s.length < size) s += base;
    return s.slice(0, size);
}

function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const ms = (n) => `${n.toFixed(1)} ms`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

/** Count loose objects currently in the in-memory .git/objects. */
function countLooseObjects(fs, dir) {
    const objDir = `${dir}/.git/objects`;
    let n = 0;
    let subdirs;
    try { subdirs = fs.readdirSync(objDir); } catch { return 0; }
    for (const sd of subdirs) {
        if (!/^[0-9a-f]{2}$/.test(sd)) continue;
        try { n += fs.readdirSync(`${objDir}/${sd}`).length; } catch { /* race */ }
    }
    return n;
}

/** Build a realistic on-disk repo: committed + gc'd so .git is packed + has a valid index. */
async function makeRepoOnDisk(dir, numFiles, fileSize) {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const writes = [];
    for (let i = 0; i < numFiles; i++) {
        writes.push(fsp.writeFile(path.join(dir, `f${i}.txt`), content(fileSize, `init-${i}`)));
    }
    await Promise.all(writes);
    const g = (c) => execSync(c, { cwd: dir, stdio: 'pipe' });
    try {
        g('git init -q');
        g('git add .');
        g('git -c user.email=bench@local -c user.name=bench commit -q -m init');
        g('git gc -q');             // pack objects → mirrors a real loaded repo
    } catch (e) {
        throw new Error(`git setup failed (is git installed?): ${e.message}`);
    }
}

/**
 * Simulate a build writing through the volume — identical path to
 * `toJustBashFs(mg)`, since `mg.volume === this.fs` (the recording-fs layer).
 * These writes hit _unpersisted but NOT _dirtyFiles, exactly like a real build.
 */
async function simulateBuild(mg, changed, added, fileSize) {
    const vol = mg.volume;
    for (let i = 0; i < changed; i++) {
        await vol.promises.writeFile(`${mg.dir}/f${i}.txt`, content(fileSize, `mod-${i}-${Date.now()}`));
    }
    for (let i = 0; i < added; i++) {
        await vol.promises.writeFile(`${mg.dir}/build-new-${i}.txt`, content(fileSize, `new-${i}`));
    }
}

async function runOnce(scenario, strategy) {
    const mg = new MemoryGit('bench');
    await mg.loadFromDisk(CFG.diskDir);
    await simulateBuild(mg, scenario.changed, scenario.added, CFG.fileSize);

    const looseBefore = countLooseObjects(mg.volume, mg.dir);
    gc();
    const heapBefore = process.memoryUsage().heapUsed;

    const t0 = process.hrtime.bigint();
    if (strategy === 'dot') {
        await mg.add('.');
    } else {
        const dirty = mg.getDirtyPaths().filter((p) => !p.startsWith('.git/'));
        if (dirty.length) await mg.add(dirty);
    }
    const t1 = process.hrtime.bigint();

    gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const looseAfter = countLooseObjects(mg.volume, mg.dir);

    // Correctness: which files actually ended up staged?
    const st = await mg.status();
    const staged = st.filter((s) => s.stage === 2 || s.stage === 3);
    const newStaged = staged.filter((s) => s.filepath.startsWith('build-new-')).length;

    return {
        ms: Number(t1 - t0) / 1e6,
        looseWritten: looseAfter - looseBefore,
        heapDelta: heapAfter - heapBefore,
        staged: staged.length,
        newStaged,
    };
}

async function measure(scenario, strategy) {
    const samples = [];
    let last;
    for (let i = 0; i < CFG.iters; i++) last = await runOnce(scenario, strategy);
    for (let i = 0; i < CFG.iters; i++) samples.push((await runOnce(scenario, strategy)).ms);
    return { ...last, ms: median(samples) };
}

function row(label, r, scenario) {
    const correct = r.newStaged === scenario.added ? '✓' : `✗ (${r.newStaged}/${scenario.added})`;
    return [
        label.padEnd(22),
        ms(r.ms).padStart(11),
        String(r.looseWritten).padStart(8),
        mb(r.heapDelta).padStart(11),
        String(r.staged).padStart(8),
        correct.padStart(10),
    ].join('  ');
}

async function scenario(name, sc) {
    console.log(`\n## ${name}`);
    console.log(`   ${CFG.numFiles} committed files · build: ${sc.changed} modified, ${sc.added} new · ${CFG.fileSize}B each · median of ${CFG.iters}\n`);
    const header = [
        'strategy'.padEnd(22),
        'add time'.padStart(11),
        'loose+'.padStart(8),
        'heap Δ'.padStart(11),
        'staged'.padStart(8),
        'new ok?'.padStart(10),
    ].join('  ');
    console.log(`   ${header}`);
    console.log(`   ${'-'.repeat(header.length)}`);

    const dot = await measure(sc, 'dot');
    const dirty = await measure(sc, 'dirty');
    console.log(`   ${row("add('.')", dot, sc)}`);
    console.log(`   ${row('add(getDirtyPaths())', dirty, sc)}`);

    const speedup = dot.ms / dirty.ms;
    console.log(`\n   → ${speedup.toFixed(1)}× faster; ${dot.looseWritten - dirty.looseWritten} fewer objects hashed/written` +
        (dot.newStaged < sc.added ? `; add('.') MISSED ${sc.added - dot.newStaged} build-created file(s)` : ''));
}

async function main() {
    console.log('# add(\'.\') optimization benchmark');
    console.log(`Building on-disk repo (${CFG.numFiles} files)…`);
    await makeRepoOnDisk(CFG.diskDir, CFG.numFiles, CFG.fileSize);

    // 1) Clean checkout, build touches a few files (the real workflow).
    await scenario('Build workflow (load → modify few → stage)', {
        changed: CFG.changed,
        added: CFG.added,
    });

    // 2) No changes at all — isolates the wasteful post-load re-hash of everything.
    await scenario('Clean checkout, no build changes (pure waste)', {
        changed: 0,
        added: 0,
    });

    await fsp.rm(CFG.diskDir, { recursive: true, force: true });
    console.log('\nColumns: loose+ = loose objects written by add · heap Δ = heap growth across add · new ok? = build-created files staged\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
