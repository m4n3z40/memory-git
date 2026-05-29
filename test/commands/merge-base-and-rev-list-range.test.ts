import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryGit } from '../../src/index';

/**
 * Coverage for the new ancestry/range APIs:
 *  - `mg.isAncestor` and `exec('merge-base --is-ancestor A B')`
 *  - `mg.revListCount` and `exec('rev-list --count A..B')`
 *  - `mg.revList({range})` and `exec('rev-list A..B')`
 *
 * Plus regression on the single-ref/`--all`/`--reverse`/`--max-count` paths
 * that have to keep working untouched.
 */

async function commit(mg: MemoryGit, file: string, content: string, msg: string): Promise<string> {
    await mg.writeFile(file, content);
    await mg.add([file]);
    return mg.commit(msg);
}

describe("isAncestor / exec('merge-base --is-ancestor')", () => {
    let mg: MemoryGit;
    beforeEach(async () => {
        mg = new MemoryGit('anc');
        mg.setAuthor('T', 't@t');
        await mg.init();
    });

    it('is reflexive: isAncestor(A, A) is true', async () => {
        const a = await commit(mg, 'a.txt', '1', 'a');
        expect(await mg.isAncestor(a, a)).toBe(true);
    });

    it('returns true for parent → child and false for child → parent', async () => {
        const parent = await commit(mg, 'a.txt', '1', 'parent');
        const child = await commit(mg, 'a.txt', '2', 'child');
        expect(await mg.isAncestor(parent, child)).toBe(true);
        expect(await mg.isAncestor(child, parent)).toBe(false);
    });

    it('walks across merges (both branch tips are ancestors of the merge commit)', async () => {
        const root = await commit(mg, 'a.txt', '1', 'root');
        await mg.exec('branch feature');
        const mainTip = await commit(mg, 'a.txt', '2', 'main');
        await mg.exec('checkout feature');
        const featTip = await commit(mg, 'b.txt', 'x', 'feature');
        await mg.exec('checkout main');
        const mergeResult = await mg.merge('feature');
        const merge = mergeResult.oid ?? (await mg.resolveRef('HEAD'));

        expect(await mg.isAncestor(mainTip, merge)).toBe(true);
        expect(await mg.isAncestor(featTip, merge)).toBe(true);
        expect(await mg.isAncestor(root, merge)).toBe(true);
        // The two tips don't reach each other across the fork.
        expect(await mg.isAncestor(mainTip, featTip)).toBe(false);
        expect(await mg.isAncestor(featTip, mainTip)).toBe(false);
    });

    it('throws on an unresolvable ref', async () => {
        await commit(mg, 'a.txt', '1', 'a');
        await expect(mg.isAncestor('does-not-exist', 'HEAD')).rejects.toThrow();
    });

    it("exec('merge-base --is-ancestor A B') returns empty on yes, throws Error with .exitCode=1 on no", async () => {
        const parent = await commit(mg, 'a.txt', '1', 'parent');
        const child = await commit(mg, 'a.txt', '2', 'child');

        const ok = await mg.exec(`merge-base --is-ancestor ${parent} ${child}`);
        expect(ok).toBe('');

        // Mirrors the diff --quiet convention: a regular Error with exitCode
        // tacked on. Shell strategies map .exitCode === 1 to native git's
        // exit-1-empty-stderr without needing an instanceof on a typed class.
        await expect(mg.exec(`merge-base --is-ancestor ${child} ${parent}`))
            .rejects.toMatchObject({ exitCode: 1 });
    });

    it('bad ref throws a regular Error without .exitCode (distinguishes "no" from "failure")', async () => {
        await commit(mg, 'a.txt', '1', 'a');
        // A shell strategy needs to tell these two apart:
        //   exit 1 (not ancestor)         → .exitCode === 1
        //   exit !=1 with stderr (failure) → .exitCode undefined
        let err: unknown;
        try {
            await mg.exec('merge-base --is-ancestor deadbeefdeadbeefdeadbeefdeadbeefdeadbeef HEAD');
        } catch (e) { err = e; }
        expect(err).toBeInstanceOf(Error);
        expect((err as Error & { exitCode?: number }).exitCode).toBeUndefined();
    });

    it("exec('merge-base A B') (without --is-ancestor) is rejected explicitly", async () => {
        await commit(mg, 'a.txt', '1', 'a');
        await expect(mg.exec('merge-base HEAD HEAD'))
            .rejects.toThrow(/only `git merge-base --is-ancestor A B`/);
    });

    it('exec form requires two refs', async () => {
        await commit(mg, 'a.txt', '1', 'a');
        await expect(mg.exec('merge-base --is-ancestor HEAD')).rejects.toThrow(/requires two refs/);
    });
});

describe('rev-list range / --count', () => {
    let mg: MemoryGit;
    beforeEach(async () => {
        mg = new MemoryGit('rl');
        mg.setAuthor('T', 't@t');
        await mg.init();
    });

    it('count(A..A) is 0', async () => {
        const a = await commit(mg, 'a.txt', '1', 'a');
        expect(await mg.revListCount({ range: { from: a, to: a } })).toBe(0);
        expect(await mg.exec(`rev-list --count ${a}..${a}`)).toBe('0');
    });

    it('count(parent..child) is 1', async () => {
        const parent = await commit(mg, 'a.txt', '1', 'p');
        const child = await commit(mg, 'a.txt', '2', 'c');
        expect(await mg.revListCount({ range: { from: parent, to: child } })).toBe(1);
        expect(await mg.exec(`rev-list --count ${parent}..${child}`)).toBe('1');
    });

    it('count(child..parent) (reversed range) is 0', async () => {
        const parent = await commit(mg, 'a.txt', '1', 'p');
        const child = await commit(mg, 'a.txt', '2', 'c');
        expect(await mg.revListCount({ range: { from: child, to: parent } })).toBe(0);
        expect(await mg.exec(`rev-list --count ${child}..${parent}`)).toBe('0');
    });

    it('range returns the intermediate commits in newest-first order', async () => {
        const root = await commit(mg, 'a.txt', '1', 'root');
        const c1 = await commit(mg, 'a.txt', '2', 'c1');
        const c2 = await commit(mg, 'a.txt', '3', 'c2');
        const c3 = await commit(mg, 'a.txt', '4', 'c3');

        const oids = await mg.revList({ range: { from: root, to: c3 } });
        expect(oids).toEqual([c3, c2, c1]);
        expect(await mg.revListCount({ range: { from: root, to: c3 } })).toBe(3);

        // Same via the bash surface.
        const cliOids = (await mg.exec(`rev-list ${root}..${c3}`)).split('\n');
        expect(cliOids).toEqual([c3, c2, c1]);
        expect(await mg.exec(`rev-list --count ${root}..${c3}`)).toBe('3');
    });

    it('accepts ref names (branches/tags/HEAD) on both sides of the range', async () => {
        const root = await commit(mg, 'a.txt', '1', 'root');
        await mg.exec(`tag base`);
        const tip = await commit(mg, 'a.txt', '2', 'tip');

        expect(await mg.revListCount({ range: { from: 'base', to: 'HEAD' } })).toBe(1);
        expect(await mg.exec('rev-list --count base..HEAD')).toBe('1');
        // Sanity: tip OID is what comes out.
        const oids = await mg.revList({ range: { from: 'base', to: 'HEAD' } });
        expect(oids).toEqual([tip]);
        expect(root).not.toBe(tip);
    });

    it('range with --max-count truncates from newest first', async () => {
        const root = await commit(mg, 'a.txt', '1', 'root');
        await commit(mg, 'a.txt', '2', 'c1');
        await commit(mg, 'a.txt', '3', 'c2');
        const c3 = await commit(mg, 'a.txt', '4', 'c3');

        const limited = await mg.revList({ range: { from: root, to: c3 }, maxCount: 2 });
        expect(limited).toHaveLength(2);
        expect(limited[0]).toBe(c3); // newest first

        const cli = (await mg.exec(`rev-list --max-count=2 ${root}..${c3}`)).split('\n');
        expect(cli).toEqual(limited);
    });

    it('dedupes commits reachable via two paths in a merge DAG (matches git rev-list)', async () => {
        // root → main2 (main) ; root → s1 → s2 (side) ; merge(main2, s2) → m
        // root is reachable from m via BOTH sides → git.log re-yields it,
        // native git rev-list dedupes. revList / revListCount must too.
        const root = await commit(mg, 'a.txt', '1', 'root');
        await mg.exec('branch side');                       // side @ root
        const main2 = await commit(mg, 'a.txt', '2', 'main2');
        await mg.exec('checkout side');
        const s1 = await commit(mg, 'b.txt', 'x', 's1');
        const s2 = await commit(mg, 'b.txt', 'y', 's2');
        await mg.exec('checkout main');
        const mergeResult = await mg.merge('side');
        const m = mergeResult.oid ?? (await mg.resolveRef('HEAD'));

        const oids = await mg.revList({ ref: 'HEAD' });
        // Five distinct commits — no repeats even though `root` and `main2`
        // are reachable via two paths.
        expect(new Set(oids).size).toBe(oids.length);
        expect(new Set(oids)).toEqual(new Set([m, main2, s2, s1, root]));
        expect(await mg.revListCount({ ref: 'HEAD' })).toBe(5);
        expect(await mg.exec('rev-list --count HEAD')).toBe('5');
    });

    it('regression: single-ref rev-list, --all, --reverse, --max-count still work', async () => {
        const a = await commit(mg, 'a.txt', '1', 'a');
        const b = await commit(mg, 'a.txt', '2', 'b');
        const c = await commit(mg, 'a.txt', '3', 'c');

        // Single ref: walks HEAD by default
        expect(await mg.exec('rev-list HEAD')).toBe([c, b, a].join('\n'));
        // --max-count caps from the front
        expect(await mg.exec('rev-list -n 2 HEAD')).toBe([c, b].join('\n'));
        // --reverse flips the order
        expect(await mg.exec('rev-list --reverse HEAD')).toBe([a, b, c].join('\n'));
        // --all walks every branch (here, just main → same commits)
        const allOut = (await mg.exec('rev-list --all')).split('\n');
        expect(new Set(allOut)).toEqual(new Set([a, b, c]));
    });
});
