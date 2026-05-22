import { describe, it, expect, beforeEach } from 'vitest';
import git from 'isomorphic-git';
import { MemoryGit } from '../../src/index';

async function writeOrphanRef(mg: MemoryGit, refName: string, files: Array<{ path: string; content: string }>): Promise<string> {
    const tree = [];
    for (const f of files) {
        const oid = await git.writeBlob({ fs: mg.fs, dir: mg.dir, blob: Buffer.from(f.content) });
        tree.push({ mode: '100644', path: f.path, oid, type: 'blob' as const });
    }
    const treeOid = await git.writeTree({ fs: mg.fs, dir: mg.dir, tree });
    const commitOid = await git.writeCommit({
        fs: mg.fs, dir: mg.dir,
        commit: {
            tree: treeOid,
            parent: [],
            author: { name: 'Test', email: 'test@test.com', timestamp: 0, timezoneOffset: 0 },
            committer: { name: 'Test', email: 'test@test.com', timestamp: 0, timezoneOffset: 0 },
            message: `${refName}\n`,
        },
    });
    await git.writeRef({ fs: mg.fs, dir: mg.dir, ref: `refs/heads/${refName}`, value: commitOid, force: true });
    return commitOid;
}

async function buildConflictRepo(name: string): Promise<MemoryGit> {
    const mg = new MemoryGit(name);
    await mg.init();
    mg.setAuthor('Test', 'test@test.com');

    await mg.writeFile('shared.txt', 'line-one\n');
    await mg.exec('add .');
    await mg.exec('commit -m base');

    await mg.exec('branch feature');
    await mg.writeFile('shared.txt', 'main-version\n');
    await mg.exec('add .');
    await mg.exec('commit -m "main edit"');

    await mg.exec('checkout feature');
    await mg.writeFile('shared.txt', 'feature-version\n');
    await mg.exec('add .');
    await mg.exec('commit -m "feature edit"');

    await mg.exec('checkout main');
    return mg;
}

describe('mg.abortMerge', () => {
    it('throws when no merge is in progress', async () => {
        const mg = new MemoryGit('abort-merge-noop');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');

        await expect(mg.abortMerge()).rejects.toThrow(/no merge to abort/i);
    });

    it('restores working tree and HEAD after a failed merge', async () => {
        const mg = await buildConflictRepo('abort-merge-conflict');
        const preMergeHead = await mg.resolveRef('HEAD');
        const preMergeContent = await mg.readFile('shared.txt');

        // Should throw because of conflicting edits to shared.txt
        await expect(mg.merge('feature')).rejects.toBeDefined();

        // HEAD didn't move; MERGE_HEAD got written
        expect(await mg.resolveRef('HEAD')).toBe(preMergeHead);

        await mg.abortMerge();

        // After abort, working tree is restored to pre-merge state
        expect(await mg.readFile('shared.txt')).toBe(preMergeContent);
        expect(await mg.resolveRef('HEAD')).toBe(preMergeHead);

        // And a second abort fails because state files are gone
        await expect(mg.abortMerge()).rejects.toThrow(/no merge to abort/i);
    });

    it('writes ORIG_HEAD on every merge attempt (success or failure)', async () => {
        const mg = new MemoryGit('abort-merge-orig-head');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');

        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m base');
        const base = await mg.resolveRef('HEAD');

        await mg.exec('branch feature');
        await mg.exec('checkout feature');
        await mg.writeFile('b.txt', 'feature');
        await mg.exec('add .');
        await mg.exec('commit -m feature');

        await mg.exec('checkout main');
        await mg.merge('feature'); // clean fast-forward merge

        // ORIG_HEAD should point to where main was before the merge
        const origHead = await mg.resolveRef('ORIG_HEAD');
        expect(origHead).toBe(base);
    });

    it('clears MERGE_HEAD state after a successful merge that follows a failed one', async () => {
        const mg = await buildConflictRepo('abort-merge-recovery');

        await expect(mg.merge('feature')).rejects.toBeDefined();
        await mg.abortMerge();

        // Resolve the divergence by overwriting + committing on main
        await mg.writeFile('shared.txt', 'reconciled\n');
        await mg.exec('add .');
        await mg.exec('commit -m reconcile');

        // Re-merge feature (still conflicts, but now ensure abort works again)
        await expect(mg.merge('feature')).rejects.toBeDefined();
        // MERGE_HEAD is back — abort works
        await mg.abortMerge();
        // And one more abort fails (state cleared)
        await expect(mg.abortMerge()).rejects.toThrow(/no merge to abort/i);
    });
});

describe('mg.merge({ strategy })', () => {
    it('with strategy="ours", conflicting edits resolve to our side', async () => {
        const mg = await buildConflictRepo('merge-strategy-ours');
        const oursContent = await mg.readFile('shared.txt');

        const result = await mg.merge('feature', { strategy: 'ours' });

        // Merge committed (not fast-forward, not already merged)
        expect(result.alreadyMerged).toBeFalsy();
        expect(result.oid).toBeTruthy();
        // File content matches our side (no conflict markers)
        expect(await mg.readFile('shared.txt')).toBe(oursContent);
        // No merge state files left behind
        await expect(mg.abortMerge()).rejects.toThrow(/no merge to abort/i);
    });

    it('with strategy="theirs", conflicting edits resolve to their side', async () => {
        const mg = await buildConflictRepo('merge-strategy-theirs');
        await mg.exec('checkout feature');
        const theirsContent = await mg.readFile('shared.txt');
        await mg.exec('checkout main');

        await mg.merge('feature', { strategy: 'theirs' });

        expect(await mg.readFile('shared.txt')).toBe(theirsContent);
    });
});

describe('mg.merge({ allowUnrelatedHistories })', () => {
    async function setupUnrelated(name: string): Promise<MemoryGit> {
        const mg = new MemoryGit(name);
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');
        await mg.writeFile('main.txt', 'main-content\n');
        await mg.exec('add .');
        await mg.exec('commit -m main-init');
        await writeOrphanRef(mg, 'orphan', [{ path: 'orphan.txt', content: 'orphan-content\n' }]);
        return mg;
    }

    it('throws without allowUnrelatedHistories on histories with no common ancestor', async () => {
        const mg = await setupUnrelated('merge-unrelated-throw');
        await expect(mg.merge('orphan')).rejects.toThrow();
    });

    it('merges with allowUnrelatedHistories=true + strategy=ours', async () => {
        const mg = await setupUnrelated('merge-unrelated-ok');
        const result = await mg.merge('orphan', {
            allowUnrelatedHistories: true,
            strategy: 'ours',
        });
        expect(result.alreadyMerged).toBeFalsy();
        expect(result.oid).toBeTruthy();
        // main.txt survives (ours), orphan.txt is brought in from the other history
        expect(await mg.readFile('main.txt')).toBe('main-content\n');
        expect(await mg.readFile('orphan.txt')).toBe('orphan-content\n');
    });
});

describe('exec("merge") flag wiring', () => {
    it('--strategy-option=ours resolves a conflict via CLI', async () => {
        const mg = await buildConflictRepo('merge-cli-ours');
        const oursContent = await mg.readFile('shared.txt');
        await mg.exec('merge --strategy-option=ours --no-edit feature');
        expect(await mg.readFile('shared.txt')).toBe(oursContent);
    });

    it('-X theirs is accepted as alias for --strategy-option=theirs', async () => {
        const mg = await buildConflictRepo('merge-cli-theirs');
        await mg.exec('checkout feature');
        const theirsContent = await mg.readFile('shared.txt');
        await mg.exec('checkout main');
        await mg.exec('merge -X theirs feature');
        expect(await mg.readFile('shared.txt')).toBe(theirsContent);
    });

    it('--allow-unrelated-histories survives the CLI round-trip', async () => {
        const mg = new MemoryGit('merge-cli-unrelated');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');
        await mg.writeFile('a.txt', 'a-main\n');
        await mg.exec('add .');
        await mg.exec('commit -m main');

        await writeOrphanRef(mg, 'orphan', [{ path: 'b.txt', content: 'orphan\n' }]);

        await mg.exec('merge --allow-unrelated-histories -X ours --no-edit orphan');
        expect(await mg.readFile('a.txt')).toBe('a-main\n');
        expect(await mg.readFile('b.txt')).toBe('orphan\n');
    });
});

describe('exec("merge --abort")', () => {
    it('drives mg.abortMerge through the CLI parser', async () => {
        const mg = await buildConflictRepo('abort-merge-cli');
        await expect(mg.exec('merge feature')).rejects.toBeDefined();

        const out = await mg.exec('merge --abort');
        expect(out).toBe('');

        // Second abort fails — state was cleaned
        await expect(mg.exec('merge --abort')).rejects.toThrow(/no merge to abort/i);
    });
});
