import { describe, it, expect, vi, afterEach } from 'vitest';
import git from 'isomorphic-git';
import { MemoryGit } from '../../src/index';

/**
 * Real git writes `.git/FETCH_HEAD` on every fetch so downstream flows
 * can do `merge FETCH_HEAD` / `diff HEAD FETCH_HEAD` without needing
 * the resolved oid. We mirror that.
 *
 * Network is stubbed — we replace `git.fetch` so the wrapper sees a
 * realistic FetchResult and we can assert on the bookkeeping it does
 * around the call.
 */

const FAKE_OID_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FAKE_OID_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

async function setupRepo(name: string): Promise<{ mg: MemoryGit; oid: string }> {
    const mg = new MemoryGit(name);
    mg.setAuthor('T', 't@t');
    await mg.init();
    await mg.writeFile('a', '1');
    await mg.add('.');
    await mg.commit('c1');
    const oid = await mg.resolveRef('HEAD');
    return { mg, oid };
}

describe('FETCH_HEAD bookkeeping', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('typed fetch({ url, ref }) writes FETCH_HEAD in real-git format', async () => {
        const { mg, oid } = await setupRepo('typed-fh');
        const description = "branch 'main' of https://example.com/r.git";
        vi.spyOn(git, 'fetch').mockResolvedValue({
            defaultBranch: 'refs/heads/main',
            fetchHead: oid,
            fetchHeadDescription: description,
            headers: {},
            pruned: [],
        });

        await mg.fetch({ url: 'https://example.com/r.git', ref: 'main' });

        const raw = (await mg.readFile('.git/FETCH_HEAD')).toString();
        expect(raw).toBe(`${oid}\t\t${description}\n`);
    });

    it('resolveRef("FETCH_HEAD") returns the merge-candidate oid', async () => {
        const { mg, oid } = await setupRepo('resolve-fh');
        vi.spyOn(git, 'fetch').mockResolvedValue({
            defaultBranch: 'refs/heads/main',
            fetchHead: oid,
            fetchHeadDescription: "branch 'main' of https://example.com/r.git",
            headers: {},
            pruned: [],
        });

        await mg.fetch({ url: 'https://example.com/r.git', ref: 'main' });

        expect(await mg.resolveRef('FETCH_HEAD')).toBe(oid);
    });

    it('exec fetch <url> <ref> writes FETCH_HEAD reachable via rev-parse', async () => {
        const { mg, oid } = await setupRepo('exec-fh');
        vi.spyOn(git, 'fetch').mockResolvedValue({
            defaultBranch: 'refs/heads/main',
            fetchHead: oid,
            fetchHeadDescription: "branch 'main' of https://example.com/r.git",
            headers: {},
            pruned: [],
        });

        await mg.exec('git fetch https://example.com/r.git main');
        const out = await mg.exec('rev-parse FETCH_HEAD');
        expect(out).toBe(oid);
    });

    it('FETCH_HEAD is overwritten on the next fetch', async () => {
        const { mg } = await setupRepo('overwrite-fh');

        const spy = vi.spyOn(git, 'fetch')
            .mockResolvedValueOnce({
                defaultBranch: 'refs/heads/main',
                fetchHead: FAKE_OID_A,
                fetchHeadDescription: 'first',
                headers: {},
                pruned: [],
            })
            .mockResolvedValueOnce({
                defaultBranch: 'refs/heads/main',
                fetchHead: FAKE_OID_B,
                fetchHeadDescription: 'second',
                headers: {},
                pruned: [],
            });

        await mg.fetch({ url: 'https://example.com/r.git' });
        const raw1 = (await mg.readFile('.git/FETCH_HEAD')).toString();
        expect(raw1).toContain(FAKE_OID_A);
        expect(raw1).toContain('first');

        await mg.fetch({ url: 'https://example.com/r.git' });
        const raw2 = (await mg.readFile('.git/FETCH_HEAD')).toString();
        expect(raw2).toContain(FAKE_OID_B);
        expect(raw2).toContain('second');
        expect(raw2).not.toContain(FAKE_OID_A);
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('skips writing FETCH_HEAD when fetchHead is null (empty remote)', async () => {
        const { mg } = await setupRepo('null-fh');
        vi.spyOn(git, 'fetch').mockResolvedValue({
            defaultBranch: null,
            fetchHead: null,
            fetchHeadDescription: null,
            headers: {},
            pruned: [],
        });

        await mg.fetch({ url: 'https://example.com/empty.git' });
        await expect(mg.resolveRef('FETCH_HEAD')).rejects.toThrow(/Could not find/i);
    });
});

describe('FETCH_HEAD resolution', () => {
    it('resolveRef("FETCH_HEAD") throws when no fetch has run', async () => {
        const { mg } = await setupRepo('no-fetch');
        await expect(mg.resolveRef('FETCH_HEAD')).rejects.toThrow(/Could not find/i);
    });

    it('parses multi-line FETCH_HEAD and prefers the merge candidate', async () => {
        const { mg, oid: oidA } = await setupRepo('multi-line');
        await mg.writeFile('b', '2');
        await mg.add('.');
        await mg.commit('c2');
        const oidB = await mg.resolveRef('HEAD');

        const fakeFetchHead =
            `${oidA}\tnot-for-merge\tbranch 'side' of file:///nowhere\n` +
            `${oidB}\t\tbranch 'main' of file:///nowhere\n`;
        await mg.writeFile('.git/FETCH_HEAD', fakeFetchHead);

        expect(await mg.resolveRef('FETCH_HEAD')).toBe(oidB);
    });

    it('FETCH_HEAD supports the rev-suffix syntax (~, ^)', async () => {
        const { mg, oid: oidA } = await setupRepo('suffix');
        await mg.writeFile('b', '2');
        await mg.add('.');
        await mg.commit('c2');
        const oidB = await mg.resolveRef('HEAD');

        await mg.writeFile('.git/FETCH_HEAD', `${oidB}\t\tbranch 'main' of file:///nowhere\n`);

        // FETCH_HEAD = oidB; FETCH_HEAD~1 should walk to oidA
        expect(await mg.resolveRef('FETCH_HEAD~1')).toBe(oidA);
        expect(await mg.resolveRef('FETCH_HEAD^0')).toBe(oidB);
    });

    it('falls back to the first line when no entry is marked as merge candidate', async () => {
        const { mg, oid } = await setupRepo('fallback');
        await mg.writeFile('.git/FETCH_HEAD', `${oid}\tnot-for-merge\tbranch 'only' of file:///x\n`);
        expect(await mg.resolveRef('FETCH_HEAD')).toBe(oid);
    });
});
