import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

import { MemoryGit } from '../../src/index';

/**
 * `ls-tree` reads from commit/tree OBJECTS, never the index — so it survives a
 * stale `.git/index`. That immunity is the whole reason it exists: a rehydrated
 * sandbox can read a cold, lagging index that omits durably-committed files;
 * `ls-tree -r --name-only HEAD` must still list them. The first test pins that
 * exact scenario (index and HEAD tree deliberately diverge).
 */
describe('ls-tree', () => {
    async function seed(name: string): Promise<MemoryGit> {
        const mg = new MemoryGit(`${name}-${Date.now()}-${Math.random()}`);
        mg.setAuthor('T', 't@t');
        await mg.init();
        return mg;
    }

    it('lists a committed file even when the index no longer tracks it (index vs HEAD diverge)', async () => {
        const mg = await seed('diverge');
        await mg.writeFile('keep.ts', 'a');
        await mg.writeFile('src/lib/utils.ts', 'export const x = 1');
        await mg.add('.');
        await mg.commit('seed');

        // Drop one file from the INDEX only — HEAD tree still has it. This is
        // the stale-index shape: `ls-files` (index) loses it, `ls-tree` (HEAD
        // object) keeps it.
        await mg.remove(['src/lib/utils.ts'], { cached: true });

        const fromIndex = await mg.lsFiles();
        expect(fromIndex).not.toContain('src/lib/utils.ts');

        const out = await mg.exec('ls-tree -r --name-only HEAD');
        const paths = out.split('\n');
        expect(paths).toContain('src/lib/utils.ts');
        expect(paths).toContain('keep.ts');
    });

    it('-r recurses into nested subdirectories', async () => {
        const mg = await seed('nested');
        await mg.writeFile('a/b/c.ts', '1');
        await mg.writeFile('a/b/d.ts', '2');
        await mg.writeFile('a/top.ts', '3');
        await mg.writeFile('root.ts', '4');
        await mg.add('.');
        await mg.commit('nest');

        const out = await mg.exec('ls-tree -r --name-only HEAD');
        expect(out.split('\n')).toEqual([
            'a/b/c.ts',
            'a/b/d.ts',
            'a/top.ts',
            'root.ts',
        ]);
    });

    it('accepts a commit SHA and a branch name as the tree-ish, not just HEAD', async () => {
        const mg = await seed('treeish');
        await mg.writeFile('one.ts', '1');
        await mg.add('.');
        await mg.commit('c1');
        const sha = await mg.resolveRef('HEAD');
        await mg.exec('branch feature');

        const want = ['one.ts'];
        expect((await mg.exec('ls-tree -r --name-only HEAD')).split('\n')).toEqual(want);
        expect((await mg.exec(`ls-tree -r --name-only ${sha}`)).split('\n')).toEqual(want);
        expect((await mg.exec('ls-tree -r --name-only feature')).split('\n')).toEqual(want);
    });

    it('accepts a raw tree SHA (peeling not required)', async () => {
        const mg = await seed('treesha');
        await mg.writeFile('x/y.ts', '1');
        await mg.add('.');
        await mg.commit('c');
        // Resolve the tree OID via show() metadata, then list it directly.
        const treeOid = (await mg.show('HEAD')).commit.tree!;
        const out = await mg.exec(`ls-tree -r --name-only ${treeOid}`);
        expect(out.split('\n')).toEqual(['x/y.ts']);
    });

    it('throws on an unborn HEAD (repo with no commits)', async () => {
        const mg = await seed('unborn');
        await expect(mg.lsTree({ treeish: 'HEAD', recursive: true })).rejects.toThrow();
        await expect(mg.exec('ls-tree -r --name-only HEAD')).rejects.toThrow();
    });

    it('throws with a clear error on an invalid ref', async () => {
        const mg = await seed('badref');
        await mg.writeFile('a.ts', '1');
        await mg.add('.');
        await mg.commit('c');
        await expect(mg.exec('ls-tree -r --name-only no-such-ref')).rejects.toThrow(/no-such-ref/);
    });

    it('full form emits `<mode> <type> <oid>\\t<path>`', async () => {
        const mg = await seed('full');
        await mg.writeFile('a.ts', '1');
        await mg.writeFile('sub/b.ts', '2');
        await mg.add('.');
        await mg.commit('c');

        const out = await mg.exec('ls-tree -r HEAD');
        for (const line of out.split('\n')) {
            expect(line).toMatch(/^100644 blob [0-9a-f]{40}\t/);
        }
        // Top-level (no -r) shows the subtree entry as a tree.
        const top = await mg.exec('ls-tree HEAD');
        expect(top).toMatch(/^100644 blob [0-9a-f]{40}\ta\.ts$/m);
        expect(top).toMatch(/^040000 tree [0-9a-f]{40}\tsub$/m);
    });

    it('-r -t emits tree entries alongside the blobs they contain', async () => {
        const mg = await seed('rt');
        await mg.writeFile('sub/b.ts', '2');
        await mg.writeFile('a.ts', '1');
        await mg.add('.');
        await mg.commit('c');

        const out = await mg.exec('ls-tree -r -t --name-only HEAD');
        // `sub` (the tree) listed right before its children, in git order.
        expect(out.split('\n')).toEqual(['a.ts', 'sub', 'sub/b.ts']);
    });
});

/**
 * Byte-for-byte parity vs the real `git` CLI on a small fixture: same paths,
 * same order. Guards the tree-order sort (directories compared as if they end
 * in `/`) and the recursive traversal against native git 2.x.
 */
describe('ls-tree parity vs native git', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mg-lstree-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const FILES: Record<string, string> = {
        'a.txt': '1',
        'sub.txt': '2',          // sorts before `sub/` (0x2e < 0x2f)
        'sub/z.txt': '3',
        'sub/nested/deep.txt': '4',
        'b/one.txt': '5',
        'z.txt': '6',
    };

    function realGit(args: string[]): string {
        return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).replace(/\n$/, '');
    }

    it('matches `git ls-tree -r --name-only HEAD` order and paths', async () => {
        const { mkdirSync, writeFileSync } = await import('fs');
        const { dirname } = await import('path');

        // Build the same fixture on real disk and in memory-git.
        realGit(['init', '-q', '-b', 'main']);
        realGit(['config', 'user.name', 'T']);
        realGit(['config', 'user.email', 't@t']);
        const mg = new MemoryGit(`parity-${Date.now()}`);
        mg.setAuthor('T', 't@t');
        await mg.init();
        for (const [p, c] of Object.entries(FILES)) {
            mkdirSync(dirname(join(dir, p)), { recursive: true });
            writeFileSync(join(dir, p), c);
            await mg.writeFile(p, c);
        }
        realGit(['add', '.']);
        realGit(['commit', '-qm', 'seed']);
        await mg.add('.');
        await mg.commit('seed');

        const real = realGit(['ls-tree', '-r', '--name-only', 'HEAD']);
        const mine = await mg.exec('ls-tree -r --name-only HEAD');
        expect(mine).toBe(real);

        // Non-recursive top level must match too (tree-order with trailing-/).
        const realTop = realGit(['ls-tree', '--name-only', 'HEAD']);
        const mineTop = await mg.exec('ls-tree --name-only HEAD');
        expect(mineTop).toBe(realTop);

        // Full form (mode/type/oid/path) parity — OIDs match because content
        // is identical and git uses the same blob hashing.
        const realFull = realGit(['ls-tree', '-r', 'HEAD']);
        const mineFull = await mg.exec('ls-tree -r HEAD');
        expect(mineFull).toBe(realFull);
    });
});
