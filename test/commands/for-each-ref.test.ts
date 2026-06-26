import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import git from 'isomorphic-git';

import { MemoryGit } from '../../src/index';
import { versioncmp } from '../../src/for-each-ref';

describe('versioncmp (git version sort)', () => {
    const lt = (a: string, b: string) => expect(Math.sign(versioncmp(a, b))).toBe(-1);
    it('orders numeric segments numerically, not lexically', () => {
        lt('v0.0.9', 'v0.0.10');
        lt('v0.0.10', 'v0.0.100');
        lt('v0.0.999', 'v0.0.1933');
        lt('v0.0.10', 'v0.0.1933');
    });
    it('matches git default versioncmp on suffixes (no versionsort config)', () => {
        // Plain strverscmp: the common prefix "v1.2.0" is followed by '-' on
        // one side and end-of-string on the other, and '-' > '\0', so
        // "v1.2.0" sorts BEFORE "v1.2.0-rc1" (verified against real git below).
        lt('v1.2.0', 'v1.2.0-rc1');
        lt('v1.2.0-rc1', 'v1.2.0-rc2');
    });
    it('is a total order (antisymmetric, reflexive)', () => {
        expect(versioncmp('v1.0.0', 'v1.0.0')).toBe(0);
        expect(Math.sign(versioncmp('v2', 'v1'))).toBe(1);
    });
});

describe('exec("for-each-ref")', () => {
    let mg: MemoryGit;
    let headOid: string;
    const N = 2000;

    beforeAll(async () => {
        mg = new MemoryGit(`fer-${Date.now()}`);
        mg.setAuthor('T', 't@t');
        await mg.init();
        await mg.writeFile('a.txt', '1');
        await mg.add('.');
        await mg.commit('seed');
        headOid = await mg.resolveRef('HEAD');

        // 2000 version tags + a few non-version tags + a couple branches.
        for (let i = 1; i <= N; i++) await mg.createTag(`v0.0.${i}`, 'HEAD');
        for (const t of ['release', 'stable', 'latest']) await mg.createTag(t, 'HEAD');
        await mg.exec('branch feature');
        await mg.exec('branch hotfix');
    }, 60000);

    it('--sort=-v:refname --count=1 returns ONLY the highest version tag (default format)', async () => {
        const out = await mg.exec("for-each-ref --sort=-v:refname --count=1 refs/tags/'v*'");
        expect(out).toBe(`${headOid} commit\trefs/tags/v0.0.${N}`);
        // Output is one line regardless of tag count.
        expect(out.split('\n')).toHaveLength(1);
    });

    it('--format=%(refname:short) on the same query returns just the tag name', async () => {
        const out = await mg.exec("for-each-ref --sort=-v:refname --count=1 --format=%(refname:short) refs/tags/'v*'");
        expect(out).toBe(`v0.0.${N}`);
    });

    it('PERF GUARD: count=1 resolves only the winner — no object reads for the other 1999', async () => {
        const resolveSpy = vi.spyOn(git, 'resolveRef');
        const readSpy = vi.spyOn(git, 'readObject');
        try {
            const out = await mg.exec("for-each-ref --sort=-v:refname --count=1 refs/tags/'v*'");
            expect(out).toBe(`${headOid} commit\trefs/tags/v0.0.${N}`);
            // Default format needs objectname + objecttype for ONE ref only.
            expect(resolveSpy).toHaveBeenCalledTimes(1);
            expect(readSpy).toHaveBeenCalledTimes(1);
        } finally {
            resolveSpy.mockRestore();
            readSpy.mockRestore();
        }
    });

    it('PERF GUARD: a refname-only format reads zero objects and resolves zero refs', async () => {
        const resolveSpy = vi.spyOn(git, 'resolveRef');
        const readSpy = vi.spyOn(git, 'readObject');
        try {
            const out = await mg.exec("for-each-ref --sort=-v:refname --count=1 --format=%(refname:short) refs/tags/'v*'");
            expect(out).toBe(`v0.0.${N}`);
            expect(resolveSpy).not.toHaveBeenCalled();
            expect(readSpy).not.toHaveBeenCalled();
        } finally {
            resolveSpy.mockRestore();
            readSpy.mockRestore();
        }
    });

    it('version sort handles 9 vs 10 vs 100 numerically (asc and desc)', async () => {
        const asc = await mg.exec(
            "for-each-ref --sort=v:refname --format=%(refname:short) refs/tags/v0.0.9 refs/tags/v0.0.10 refs/tags/v0.0.100"
        );
        expect(asc.split('\n')).toEqual(['v0.0.9', 'v0.0.10', 'v0.0.100']);
        const desc = await mg.exec(
            "for-each-ref --sort=-v:refname --format=%(refname:short) refs/tags/v0.0.9 refs/tags/v0.0.10 refs/tags/v0.0.100"
        );
        expect(desc.split('\n')).toEqual(['v0.0.100', 'v0.0.10', 'v0.0.9']);
    });

    it('default sort is lexicographic refname (ascending), NOT version', async () => {
        const out = await mg.exec(
            "for-each-ref --format=%(refname:short) refs/tags/v0.0.9 refs/tags/v0.0.10 refs/tags/v0.0.100"
        );
        // Lexicographic: '1' < '9', so v0.0.10 and v0.0.100 precede v0.0.9.
        expect(out.split('\n')).toEqual(['v0.0.10', 'v0.0.100', 'v0.0.9']);
    });

    it('--count caps the output after sorting', async () => {
        const out = await mg.exec("for-each-ref --sort=-v:refname --count=3 --format=%(refname:short) refs/tags/'v*'");
        expect(out.split('\n')).toEqual([`v0.0.${N}`, `v0.0.${N - 1}`, `v0.0.${N - 2}`]);
    });

    it('pattern filtering: refs/heads/ selects branches only, refs/tags/ tags only', async () => {
        const heads = await mg.exec('for-each-ref --format=%(refname:short) refs/heads/');
        expect(heads.split('\n').sort()).toEqual(['feature', 'hotfix', 'main']);

        const tagsOnly = await mg.exec("for-each-ref --format=%(refname) refs/tags/'v*'");
        for (const line of tagsOnly.split('\n')) expect(line.startsWith('refs/tags/v0.0.')).toBe(true);
        expect(tagsOnly.split('\n')).toHaveLength(N);
    });

    it('no pattern lists heads + tags (every ref enumerated)', async () => {
        const all = (await mg.exec('for-each-ref --format=%(refname)')).split('\n');
        expect(all).toContain('refs/heads/main');
        expect(all).toContain('refs/tags/release');
        expect(all).toContain(`refs/tags/v0.0.${N}`);
    });

    it('default format string matches git: "%(objectname) %(objecttype)\\t%(refname)"', async () => {
        const out = await mg.exec('for-each-ref refs/heads/main');
        expect(out).toBe(`${headOid} commit\trefs/heads/main`);
    });

    it('%(objectname:short[=n]) abbreviates the oid', async () => {
        const def = await mg.exec('for-each-ref --format=%(objectname:short) refs/heads/main');
        expect(def).toBe(headOid.slice(0, 7));
        const n = await mg.exec('for-each-ref --format=%(objectname:short=12) refs/heads/main');
        expect(n).toBe(headOid.slice(0, 12));
    });

    // Regression: a single-quoted --format value (what any shell-quoting caller
    // emits, since the value contains `()`) must interpolate identically to the
    // unquoted form. The tokenizer used to backslash-escape the parens inside
    // the quotes, so the atom never matched and was echoed verbatim.
    describe('quoting the --format value is a no-op', () => {
        const base = "for-each-ref --sort=-v:refname --count=1";
        const tail = "refs/tags/'v*'";
        for (const atom of ['%(refname)', '%(refname:short)', '%(objectname)', '%(objectname:short)', '%(objecttype)']) {
            it(`single-quoted '${atom}' === unquoted ${atom}`, async () => {
                const unquoted = await mg.exec(`${base} --format=${atom} ${tail}`);
                const quoted = await mg.exec(`${base} --format='${atom}' ${tail}`);
                expect(quoted).toBe(unquoted);
                // And no leftover backslashes/parens leaked through.
                expect(quoted).not.toContain('\\');
            });
        }

        it('a mixed literal+atom format interpolates when single-quoted', async () => {
            // The literal space means this MUST be quoted to stay one arg
            // (unquoted, the shell splits it) — so quoting is required here,
            // not a no-op. Assert it interpolates to the golden line.
            const quoted = await mg.exec(`${base} --format='%(objectname:short) %(refname:short)' ${tail}`);
            expect(quoted).toBe(`${headOid.slice(0, 7)} v0.0.${N}`);
        });
    });
});

/**
 * Byte-for-byte parity vs native git on name-based formats and ordering.
 * (Commit-oid formats are excluded: commit OIDs depend on committer timestamp,
 * which memory-git and real git don't share — the oid path is pinned against
 * memory-git's own resolveRef in the suite above, mirroring show-ref.test.ts.)
 */
describe('for-each-ref parity vs native git', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mg-fer-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    function realGit(args: string[]): string {
        return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).replace(/\n$/, '');
    }

    it('matches version sort, count, pattern filtering and :short stripping', async () => {
        realGit(['init', '-q', '-b', 'main']);
        realGit(['config', 'user.name', 'T']);
        realGit(['config', 'user.email', 't@t']);
        writeFileSync(join(dir, 'a.txt'), '1');
        realGit(['add', '.']);
        realGit(['commit', '-qm', 'seed']);

        const mg = new MemoryGit(`parity-${Date.now()}`);
        mg.setAuthor('T', 't@t');
        await mg.init();
        await mg.writeFile('a.txt', '1');
        await mg.add('.');
        await mg.commit('seed');

        const versions = ['v0.0.9', 'v0.0.10', 'v0.0.100', 'v0.0.999', 'v0.0.1933', 'v1.2.0-rc1', 'v1.2.0'];
        for (const v of versions) {
            realGit(['tag', v]);
            await mg.createTag(v, 'HEAD');
        }
        realGit(['branch', 'feature']);
        await mg.exec('branch feature');

        const cases: string[][] = [
            ['for-each-ref', '--sort=-v:refname', '--count=1', '--format=%(refname:short)', 'refs/tags/v*'],
            ['for-each-ref', '--sort=v:refname', '--format=%(refname:short)', 'refs/tags/v*'],
            ['for-each-ref', '--format=%(refname:short)', 'refs/tags/v*'],   // default sort
            ['for-each-ref', '--format=%(refname)', 'refs/heads/'],
            ['for-each-ref', '--sort=-v:refname', '--count=3', '--format=%(refname)', 'refs/tags/v*'],
            ['for-each-ref', '--format=%(refname:short)'],                   // all refs, default sort
        ];
        for (const args of cases) {
            const real = realGit(args);
            const mine = await mg.exec(args.join(' '));
            expect(mine, `args: ${args.join(' ')}`).toBe(real);
        }
    });
});
