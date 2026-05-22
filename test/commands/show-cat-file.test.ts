import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryGit } from '../../src/index';

describe('show <ref>:<path> (cat-file syntax)', () => {
    let mg: MemoryGit;
    let oid: string;

    beforeEach(async () => {
        mg = new MemoryGit(`show-cat-${Date.now()}-${Math.random()}`);
        mg.setAuthor('T', 't@t');
        await mg.init();
        await mg.writeFile('hello.txt', 'world');
        await mg.writeFile('nested/deep.txt', 'inside');
        await mg.add('.');
        await mg.commit('seed');
        oid = await mg.resolveRef('HEAD');
    });

    it('returns file contents at HEAD', async () => {
        expect(await mg.exec('show HEAD:hello.txt')).toBe('world');
    });

    it('returns file contents at an explicit oid', async () => {
        expect(await mg.exec(`show ${oid}:hello.txt`)).toBe('world');
    });

    it('returns file contents at a branch ref', async () => {
        await mg.exec('branch side');
        expect(await mg.exec('show side:hello.txt')).toBe('world');
    });

    it('handles nested paths', async () => {
        expect(await mg.exec('show HEAD:nested/deep.txt')).toBe('inside');
    });

    it('defaults to HEAD when the ref is empty (`:path`)', async () => {
        expect(await mg.exec('show :hello.txt')).toBe('world');
    });

    it('preserves the path when it contains a colon', async () => {
        // Split on FIRST colon only — refs like `refs/heads/main:src/x.ts` work.
        await mg.writeFile('odd:name.txt', 'colon-in-name');
        await mg.add('.');
        await mg.commit('add odd');
        // Path component after the first `:` contains another colon
        expect(await mg.exec('show HEAD:odd:name.txt')).toBe('colon-in-name');
    });

    it('throws when the file does not exist at the ref', async () => {
        await expect(mg.exec('show HEAD:does-not-exist.txt')).rejects.toThrow();
    });

    it('still works for `show <ref>` (commit display, no colon)', async () => {
        const out = await mg.exec(`show ${oid}`);
        expect(out).toContain(`commit ${oid}`);
        expect(out).toContain('seed');
    });

    it('returns content at FETCH_HEAD', async () => {
        // Hand-craft FETCH_HEAD pointing at our commit
        await mg.writeFile('.git/FETCH_HEAD', `${oid}\t\tbranch 'main' of file:///nowhere\n`);
        expect(await mg.exec('show FETCH_HEAD:hello.txt')).toBe('world');
    });
});

describe('merge FETCH_HEAD', () => {
    it('resolves FETCH_HEAD as the merge source instead of treating the file body as a ref', async () => {
        const mg = new MemoryGit(`merge-fh-${Date.now()}`);
        mg.setAuthor('T', 't@t');
        await mg.init();
        await mg.writeFile('shared.txt', 'base\n');
        await mg.add('.');
        await mg.commit('base');
        await mg.exec('branch sim-remote');
        await mg.writeFile('shared.txt', 'local\n');
        await mg.add('.');
        await mg.commit('local');
        await mg.exec('checkout sim-remote');
        await mg.writeFile('shared.txt', 'remote\n');
        await mg.add('.');
        await mg.commit('remote');
        const remoteOid = await mg.resolveRef('HEAD');
        await mg.exec('checkout main');

        // Simulate what a successful fetch would have written
        await mg.writeFile('.git/FETCH_HEAD', `${remoteOid}\t\tbranch 'main' of https://example.com/r.git\n`);

        const out = await mg.exec('merge FETCH_HEAD --no-edit --strategy-option=ours');
        expect(out).toMatch(/Merge made/i);
        expect(await mg.readFile('shared.txt')).toBe('local\n');
    });

    it('fast-forward merge from FETCH_HEAD works', async () => {
        const mg = new MemoryGit(`merge-fh-ff-${Date.now()}`);
        mg.setAuthor('T', 't@t');
        await mg.init();
        await mg.writeFile('a', '1');
        await mg.add('.');
        await mg.commit('c1');
        await mg.exec('branch sim-remote');
        await mg.exec('checkout sim-remote');
        await mg.writeFile('b', '2');
        await mg.add('.');
        await mg.commit('c2');
        const remoteOid = await mg.resolveRef('HEAD');
        await mg.exec('checkout main');

        await mg.writeFile('.git/FETCH_HEAD', `${remoteOid}\t\tbranch 'main' of https://example.com/r.git\n`);

        const out = await mg.exec('merge FETCH_HEAD --no-edit');
        expect(out).toMatch(/Fast-forward/);
        expect(await mg.resolveRef('HEAD')).toBe(remoteOid);
    });
});
