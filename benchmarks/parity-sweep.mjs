// Native git ↔ memory-git CLI parity sweep.
// Builds a deterministic on-disk repo (fixed dates, mix of lightweight and
// annotated tags, side branch + merge), loads it into MemoryGit, then runs
// the same command via execSync(git) and mg.exec, normalizes both outputs,
// and compares. Reports ✓ (byte-match), ✗ (diff + first ~6 lines), and ⊘
// (intentionally skipped) per command.
//
// Run: `node benchmarks/parity-sweep.mjs`
// Requires `git` on PATH.

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryGit } from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
void __dirname; // anchor: file location for relative debug if needed

const dir = mkdtempSync(join(tmpdir(), 'mg-parity-'));
const DATE = '2026-01-01T00:00:00Z';
const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_AUTHOR_DATE: DATE,
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_DATE: DATE,
};
const g = (cmd, opts) => execSync(cmd, { cwd: dir, stdio: 'pipe', env, ...opts }).toString();
const gExit = (cmd) => {
    try { execSync(cmd, { cwd: dir, stdio: 'pipe', env }); return 0; }
    catch (e) { return e.status; }
};

g('git init -q -b main');
g('git config user.email t@t');
g('git config user.name T');
writeFileSync(join(dir, 'a.txt'), 'a\n');
g('git add .'); g('git commit -q -m c1');
writeFileSync(join(dir, 'a.txt'), 'a\nb\n');
g('git add .'); g('git commit -q -m c2');
g('git tag v1');
g('git checkout -q -b side');
writeFileSync(join(dir, 'b.txt'), 'side\n');
g('git add .'); g('git commit -q -m s1');
writeFileSync(join(dir, 'b.txt'), 'side\nmore\n');
g('git add .'); g('git commit -q -m s2');
g('git tag -a v1.1 -m annotated');
g('git checkout -q main');
writeFileSync(join(dir, 'a.txt'), 'a\nb\nc\n');
g('git add .'); g('git commit -q -m c3');
g('git merge --no-ff -q -m merge side');
g('git tag v2');

const HEAD = g('git rev-parse HEAD').trim();
const HEAD1 = g('git rev-parse HEAD~1').trim();

const mg = new MemoryGit('parity');
await mg.loadFromDisk(dir);

const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/g, '');
const results = [];
async function check(label, cmd, { exit = false, normalize = norm, skipReason } = {}) {
    if (skipReason) { results.push({ status: '⊘', label, cmd, reason: skipReason }); return; }
    let native, mine, nativeErr, myErr;
    if (exit) {
        native = String(gExit(`git ${cmd}`));
        try { await mg.exec(cmd); mine = '0'; }
        catch (e) { mine = String(e?.exitCode ?? 'thrown'); myErr = e?.message?.split('\n')[0]; }
    } else {
        try { native = g(`git ${cmd}`); } catch (e) { nativeErr = (e.stderr ?? '').toString().split('\n')[0]; native = ''; }
        try { mine = await mg.exec(cmd); } catch (e) { myErr = (e?.message ?? '').split('\n')[0]; mine = ''; }
    }
    const n = normalize(native);
    const m = normalize(mine);
    if (n === m && !nativeErr && !myErr) results.push({ status: '✓', label, cmd });
    else if (n === m && (nativeErr || myErr)) results.push({ status: '✓', label, cmd, note: 'both errored same' });
    else results.push({ status: '✗', label, cmd, native: n, mine: m, nativeErr, myErr });
}

const normLog = (s) => norm(s).replace(/^Date:.*$/gm, 'Date:').replace(/^Author:.*$/gm, 'Author:');

await check('rev-parse HEAD',         'rev-parse HEAD');
await check('rev-parse --short',      `rev-parse --short ${HEAD}`);
await check('rev-parse --abbrev-ref', 'rev-parse --abbrev-ref HEAD');
await check('rev-parse short branch', 'rev-parse main');

await check('log -n 1',               'log -n 1', { normalize: normLog });
await check('log --oneline -n 3',     'log --oneline -n 3');
await check('log --format=%H -n 3',   'log --format=%H -n 3');

await check('show HEAD',              'show HEAD', { normalize: normLog });

await check('status',                 'status');
await check('status --porcelain',     'status --porcelain');
await check('status -s',              'status -s');

await check('diff HEAD HEAD~1',       'diff HEAD HEAD~1');
await check('diff --name-only',       'diff --name-only HEAD HEAD~1');
await check('diff --stat',            'diff --stat HEAD HEAD~1');
await check('diff --quiet (clean)',   'diff --quiet HEAD HEAD',  { exit: true });
await check('diff --quiet (dirty)',   'diff --quiet HEAD HEAD~1',{ exit: true });

await check('branch',                 'branch');
await check('branch -a',              'branch -a');
await check('branch --show-current',  'branch --show-current');
await check('tag',                    'tag');
await check('tag -l',                 'tag -l');
await check('show-ref',               'show-ref');
await check('show-ref --tags',        'show-ref --tags');
await check('show-ref --heads',       'show-ref --heads');

await check('describe HEAD',          'describe HEAD');
await check('describe --tags HEAD',   'describe --tags HEAD');
await check('describe --exact-match', `describe --exact-match HEAD`);

await check('rev-list HEAD -n 3',     'rev-list HEAD -n 3');
await check('rev-list --count HEAD',  'rev-list --count HEAD');
await check('rev-list --all',         'rev-list --all');
await check('rev-list HEAD~3..HEAD',  `rev-list ${HEAD1}..${HEAD}`);
await check('rev-list --count A..B',  `rev-list --count ${HEAD1}..${HEAD}`);

await check('ls-files',               'ls-files');

await check('merge-base --is-anc 0',  `merge-base --is-ancestor ${HEAD1} ${HEAD}`, { exit: true });
await check('merge-base --is-anc 1',  `merge-base --is-ancestor ${HEAD} ${HEAD1}`, { exit: true });

await check('config user.email',      'config user.email');
await check('remote -v',              'remote -v');

const pad = (s, n) => String(s).padEnd(n);
let ok = 0, bad = 0, skipped = 0;
for (const r of results) {
    const tag = `[${r.status}]`;
    if (r.status === '✓') {
        ok++;
        console.log(`${tag} ${pad(r.label, 28)}  ${r.cmd}${r.note ? `   (${r.note})` : ''}`);
    } else if (r.status === '⊘') {
        skipped++;
        console.log(`${tag} ${pad(r.label, 28)}  ${r.cmd}  (${r.reason})`);
    } else {
        bad++;
        console.log(`${tag} ${pad(r.label, 28)}  ${r.cmd}`);
        const nLines = (r.native || '').split('\n').slice(0, 5);
        const mLines = (r.mine || '').split('\n').slice(0, 5);
        console.log(`     native: ${JSON.stringify(nLines)}${r.nativeErr ? ` ERR:"${r.nativeErr}"` : ''}`);
        console.log(`     mg    : ${JSON.stringify(mLines)}${r.myErr ? ` ERR:"${r.myErr}"` : ''}`);
    }
}
console.log(`\n${ok} match · ${bad} divergence · ${skipped} skipped · ${results.length} total`);

rmSync(dir, { recursive: true, force: true });
process.exit(bad > 0 ? 1 : 0);
