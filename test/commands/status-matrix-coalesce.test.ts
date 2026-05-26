import { describe, it, expect, afterEach, vi } from 'vitest';
import git from 'isomorphic-git';
import { MemoryGit } from '../../src/index';

/**
 * #3 — in-flight coalescing of the status matrix. status / diff / statusText /
 * the empty-commit guard / reset --mixed all build the same full matrix; a
 * concurrent burst should walk the tree once. Unlike the branch/tag caches the
 * result is NOT retained across settlement, so a read after an awaited write
 * always sees fresh state.
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

describe('statusMatrix in-flight coalescing', () => {
    afterEach(() => vi.restoreAllMocks());

    it('collapses a concurrent read burst to one underlying statusMatrix', async () => {
        const mg = await repo('coalesce');
        await mg.writeFile('b.txt', '2'); // dirty so there is real work

        const spy = vi.spyOn(git, 'statusMatrix');
        await Promise.all([mg.status(), mg.diff(), mg.statusText(), mg.status()]);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does NOT share across an awaited write (no staleness)', async () => {
        const mg = await repo('fresh');
        const spy = vi.spyOn(git, 'statusMatrix');

        await mg.status();
        await mg.writeFile('c.txt', '3');
        await mg.add('.');
        const after = await mg.status();

        expect(spy).toHaveBeenCalledTimes(2); // each awaited call builds fresh
        expect(after.some(f => f.filepath === 'c.txt')).toBe(true);
    });

    it('reflects a staged file added between two sequential reads', async () => {
        const mg = await repo('reflect');
        expect((await mg.status()).some(f => f.filepath === 'new.txt')).toBe(false);
        await mg.writeFile('new.txt', 'x');
        await mg.add('.');
        expect((await mg.status()).some(f => f.filepath === 'new.txt')).toBe(true);
    });

    it('a failed build does not wedge later callers', async () => {
        const mg = await repo('recover');
        const spy = vi.spyOn(git, 'statusMatrix')
            .mockRejectedValueOnce(new Error('boom'));

        await expect(mg.status()).rejects.toThrow('boom');
        // in-flight slot cleared on rejection → next call runs the real impl
        spy.mockRestore();
        const ok = await mg.status();
        expect(Array.isArray(ok)).toBe(true);
    });

    it('concurrent status + commit still produce a correct commit', async () => {
        const mg = await repo('commit-race');
        await mg.writeFile('d.txt', '4');
        await mg.add('.');
        // commit's empty-check guard builds a matrix concurrently with status()
        const [, sha] = await Promise.all([mg.status(), mg.commit('c2')]);
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        expect(await mg.readFileAtRef('d.txt', sha)).toBe('4');
    });

    it('returned matrices are consistent across coalesced callers', async () => {
        const mg = await repo('consistent');
        await mg.writeFile('e.txt', '5'); // untracked
        const [s1, s2] = await Promise.all([mg.status(), mg.status()]);
        expect(s1).toEqual(s2);
    });
});
