import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import git from 'isomorphic-git';
import { MemoryGit } from '../../src/index';

/**
 * Covers the current-branch / branch-list caches: concurrent-load
 * coalescing (a burst collapses to one underlying read), lifetime cache
 * hits, and invalidation correctness on every ref-mutating op.
 *
 * Spying works here because vitest runs the TS source, so the test and
 * MemoryGit import the same isomorphic-git module instance.
 */

async function repo(name: string): Promise<MemoryGit> {
    const mg = new MemoryGit(`${name}-${Date.now()}-${Math.random()}`);
    mg.setAuthor('T', 't@t');
    await mg.init();
    await mg.writeFile('a.txt', '1');
    await mg.add('.');
    await mg.commit('c1');
    return mg;
}

describe('branch caches — coalescing', () => {
    afterEach(() => vi.restoreAllMocks());

    it('collapses a concurrent burst to a single underlying read each', async () => {
        const mg = await repo('coalesce');
        await mg.createBranch('feature'); // invalidate → cold cache

        const cb = vi.spyOn(git, 'currentBranch');
        const lb = vi.spyOn(git, 'listBranches');

        await Promise.all([
            mg.currentBranch(), mg.currentBranch(), mg.currentBranch(), mg.currentBranch(),
            mg.listBranches(), mg.listBranches(), mg.listBranches(),
        ]);

        expect(cb).toHaveBeenCalledTimes(1);
        expect(lb).toHaveBeenCalledTimes(1);
    });

    it('serves repeated reads from cache (zero underlying reads when warm)', async () => {
        const mg = await repo('warm');
        await mg.currentBranch(); // warm both
        await mg.listBranches();

        const cb = vi.spyOn(git, 'currentBranch');
        const lb = vi.spyOn(git, 'listBranches');

        for (let i = 0; i < 10; i++) {
            await mg.currentBranch();
            await mg.listBranches();
        }
        expect(cb).not.toHaveBeenCalled();
        expect(lb).not.toHaveBeenCalled();
    });

    it('does not re-read after a ref MOVE (commit/reset leave names + current intact)', async () => {
        const mg = await repo('move');
        await mg.currentBranch();
        await mg.listBranches();

        const cb = vi.spyOn(git, 'currentBranch');
        const lb = vi.spyOn(git, 'listBranches');

        await mg.writeFile('b.txt', '2');
        await mg.add('.');
        await mg.commit('c2');
        await mg.reset('HEAD~1', { mode: 'soft' });

        expect(await mg.currentBranch()).toBe('main');
        expect(cb).not.toHaveBeenCalled(); // commit/reset don't move HEAD's branch
        expect(lb).not.toHaveBeenCalled();
    });
});

describe('branch caches — invalidation correctness', () => {
    it('reflects createBranch', async () => {
        const mg = await repo('inv-create');
        expect((await mg.listBranches()).map(b => b.name).sort()).toEqual(['main']);
        await mg.createBranch('feature');
        expect((await mg.listBranches()).map(b => b.name).sort()).toEqual(['feature', 'main']);
    });

    it('reflects checkout (current branch changes)', async () => {
        const mg = await repo('inv-checkout');
        await mg.createBranch('feature');
        expect(await mg.currentBranch()).toBe('main');
        await mg.checkout('feature');
        expect(await mg.currentBranch()).toBe('feature');
    });

    it('reflects checkout -b via exec', async () => {
        const mg = await repo('inv-checkout-b');
        await mg.exec('checkout -b hotfix');
        expect(await mg.currentBranch()).toBe('hotfix');
        expect((await mg.listBranches()).map(b => b.name).sort()).toEqual(['hotfix', 'main']);
    });

    it('reflects renameBranch (current follows the rename)', async () => {
        const mg = await repo('inv-rename');
        await mg.exec('checkout -b old');
        await mg.renameBranch('old', 'new');
        expect(await mg.currentBranch()).toBe('new');
        expect((await mg.listBranches()).map(b => b.name).sort()).toEqual(['main', 'new']);
    });

    it('reflects deleteBranch', async () => {
        const mg = await repo('inv-delete');
        await mg.createBranch('feature');
        await mg.deleteBranch('feature');
        expect((await mg.listBranches()).map(b => b.name)).toEqual(['main']);
    });

    it('reflects branch list marking the current branch', async () => {
        const mg = await repo('inv-current-flag');
        await mg.createBranch('feature');
        await mg.checkout('feature');
        const branches = await mg.listBranches();
        expect(branches.find(b => b.name === 'feature')?.current).toBe(true);
        expect(branches.find(b => b.name === 'main')?.current).toBe(false);
    });

    it('reflects a fresh repo after clear()', async () => {
        const mg = await repo('inv-clear');
        await mg.createBranch('feature');
        await mg.currentBranch();
        await mg.listBranches();
        await mg.clear();
        await mg.init();
        await mg.writeFile('z', '1');
        await mg.add('.');
        await mg.commit('fresh');
        expect((await mg.listBranches()).map(b => b.name)).toEqual(['main']);
        expect(await mg.currentBranch()).toBe('main');
    });

    it('reflects refs after loadFromDisk replaces the source', async () => {
        // Seed a disk repo with two branches, load it, and confirm the
        // caches reflect the loaded refs (not a stale prior state).
        const seed = await repo('inv-load-seed');
        await seed.createBranch('release');
        const dir = `/tmp/branch-cache-load-${Date.now()}`;
        await seed.flush(dir);

        const mg = new MemoryGit('inv-load');
        mg.setAuthor('T', 't@t');
        await mg.init();
        await mg.currentBranch(); // warm with the empty-init state
        await mg.loadFromDisk(dir);
        expect((await mg.listBranches()).map(b => b.name).sort()).toEqual(['main', 'release']);
    });
});
