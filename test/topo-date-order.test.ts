import { describe, it, expect } from 'vitest';
import { MemoryGit } from '../src/index';

/**
 * Pin git's topo+date order for log / rev-list in merge DAGs. iso-git's
 * `git.log` walks depth-first per parent (clumping side branches);
 * `_walkTopoDate` re-emits in newest-first order with FIFO tiebreak on
 * equal committer timestamps — matching `git log` / `git rev-list` byte-
 * for-byte. Regression guard for the parity sweep wins.
 */

const ME = { name: 'T', email: 't@t', timestamp: 1700000000, timezoneOffset: 0 } as const;
const A = { author: { ...ME }, committer: { ...ME } } as const;

async function mergeRepo(name: string): Promise<{
    mg: MemoryGit;
    merge: string;
    c3: string;
    s2: string;
    s1: string;
    c2: string;
    c1: string;
}> {
    const mg = new MemoryGit(name);
    mg.setAuthor('T', 't@t');
    await mg.init();
    await mg.writeFile('a', '1'); await mg.add('.'); const c1 = await mg.commit('c1', A);
    await mg.writeFile('a', '2'); await mg.add('.'); const c2 = await mg.commit('c2', A);
    await mg.exec('branch side');
    await mg.exec('checkout side');
    await mg.writeFile('b', 'x'); await mg.add('.'); const s1 = await mg.commit('s1', A);
    await mg.writeFile('b', 'y'); await mg.add('.'); const s2 = await mg.commit('s2', A);
    await mg.exec('checkout main');
    await mg.writeFile('a', '3'); await mg.add('.'); const c3 = await mg.commit('c3', A);
    const res = await mg.merge('side', { noFastForward: true, message: 'merge', ...A });
    return { mg, merge: res.oid!, c3, s2, s1, c2, c1 };
}

describe('topo+date walk order (matches git log / git rev-list)', () => {
    it('rev-list HEAD emits merge → first-parent → second-parent (FIFO on tied timestamps)', async () => {
        const { mg, merge, c3, s2, s1, c2, c1 } = await mergeRepo('topo-1');
        // With all commits sharing GIT_COMMITTER_DATE, native git breaks ties
        // by first-parent order: merge's parents are [c3 (was main HEAD), s2
        // (merged-in)]; c3 must be popped before s2. Pin the first 3 positions
        // (verified against native git via the parity sweep) and the dedup
        // (every commit emitted once even though c2/c1 are reachable via
        // both main and side).
        const oids = await mg.revList({ ref: 'HEAD' });
        expect(oids.slice(0, 3)).toEqual([merge, c3, s2]);
        expect(oids).toHaveLength(6);
        expect(new Set(oids)).toEqual(new Set([merge, c3, s2, s1, c2, c1]));
    });

    it("log -n 3 mirrors `git log -n 3` order on a merge commit", async () => {
        const { mg, merge, c3, s2 } = await mergeRepo('topo-2');
        const out = await mg.exec('log --oneline -n 3');
        const lines = out.split('\n');
        expect(lines).toEqual([
            `${merge.slice(0,7)} merge`,
            `${c3.slice(0,7)} c3`,
            `${s2.slice(0,7)} s2`,
        ]);
    });

    it('log --format=%H -n 3 matches the topo+date head', async () => {
        const { mg, merge, c3, s2 } = await mergeRepo('topo-3');
        const out = await mg.exec('log --format=%H -n 3');
        expect(out.split('\n')).toEqual([merge, c3, s2]);
    });

    it('rev-list --all seeds with every ref (branches + tags + remotes), not just branches', async () => {
        // Lightweight tag on c2: in --all native git seeds the walker with
        // every ref, so c2 enters the queue from the v1 tag tip BEFORE it
        // would be reached by walking down from side's tip. Without the
        // showRefs seed (branches-only) c2 would land much later.
        const { mg, merge, c2 } = await mergeRepo('topo-4');
        await mg.exec(`tag v1 ${c2}`);
        const oids = await mg.revList({ all: true });
        expect(oids[0]).toBe(merge);
        // c2 surfaces among the first few because v1 tag seeded it directly.
        expect(oids.slice(0, 4)).toContain(c2);
        expect(oids).toHaveLength(6);
    });
});
