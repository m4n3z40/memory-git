import { describe, it, expect } from 'vitest';
import git from 'isomorphic-git';
import { MemoryGit } from '../../src/index';

// Build a parentless (unrelated history) commit with nested files.
async function buildTree(mg: MemoryGit, files: Array<{ path: string; content: string; mode?: string }>): Promise<string> {
    const blobs: Array<{ mode: string; path: string; oid: string; type: 'blob' }> = [];
    const dirs = new Map<string, Array<{ path: string; content: string; mode?: string }>>();
    for (const f of files) {
        const i = f.path.indexOf('/');
        if (i === -1) {
            const oid = await git.writeBlob({ fs: mg.fs, dir: mg.dir, blob: Buffer.from(f.content) });
            blobs.push({ mode: f.mode ?? '100644', path: f.path, oid, type: 'blob' });
        } else {
            const top = f.path.slice(0, i);
            if (!dirs.has(top)) dirs.set(top, []);
            dirs.get(top)!.push({ ...f, path: f.path.slice(i + 1) });
        }
    }
    const tree: Array<{ mode: string; path: string; oid: string; type: 'blob' | 'tree' }> = [...blobs];
    for (const [dir, sub] of dirs) {
        tree.push({ mode: '040000', path: dir, oid: await buildTree(mg, sub), type: 'tree' });
    }
    return git.writeTree({ fs: mg.fs, dir: mg.dir, tree });
}

async function orphanRef(mg: MemoryGit, refName: string, files: Array<{ path: string; content: string; mode?: string }>): Promise<string> {
    const treeOid = await buildTree(mg, files);
    const commitOid = await git.writeCommit({
        fs: mg.fs, dir: mg.dir,
        commit: {
            tree: treeOid, parent: [],
            author: { name: 'T', email: 't@t.com', timestamp: 0, timezoneOffset: 0 },
            committer: { name: 'T', email: 't@t.com', timestamp: 0, timezoneOffset: 0 },
            message: `${refName}\n`,
        },
    });
    await git.writeRef({ fs: mg.fs, dir: mg.dir, ref: `refs/heads/${refName}`, value: commitOid, force: true });
    return commitOid;
}

async function fresh(name: string): Promise<MemoryGit> {
    const mg = new MemoryGit(name);
    await mg.init();
    mg.setAuthor('T', 't@t.com');
    return mg;
}

// ours = main with a common ancestor; remote branch diverges from it.
async function diverged(name: string, baseFiles: Record<string, string>): Promise<MemoryGit> {
    const mg = await fresh(name);
    for (const [p, c] of Object.entries(baseFiles)) await mg.writeFile(p, c);
    await mg.exec('add .');
    await mg.exec('commit -m base');
    await mg.exec('branch remote');
    return mg;
}

describe('merge -X ours|theirs resolves tree-level conflicts (no abort)', () => {
    it('modify-on-ours / delete-on-theirs → ours keeps the file', async () => {
        const mg = await diverged('md-ours', { 'keep.txt': 'base\n', 'other.txt': 'x\n' });
        await mg.writeFile('keep.txt', 'ours-edit\n');
        await mg.exec('add .');
        await mg.exec('commit -m ours');
        await mg.exec('checkout remote');
        await mg.exec('rm keep.txt');
        await mg.exec('add .');
        await mg.exec('commit -m "remote deletes keep"');
        const remote = await mg.resolveRef('HEAD');
        await mg.exec('checkout main');

        const result = await mg.merge(remote, { strategy: 'ours' });
        expect(result.oid).toBeTruthy();
        expect(await mg.readFile('keep.txt')).toBe('ours-edit\n');
        await expect(mg.abortMerge()).rejects.toThrow(/no merge to abort/i);
    });

    it('modify-on-ours / delete-on-theirs → theirs drops the file', async () => {
        const mg = await diverged('md-theirs', { 'keep.txt': 'base\n' });
        await mg.writeFile('keep.txt', 'ours-edit\n');
        await mg.exec('add .');
        await mg.exec('commit -m ours');
        await mg.exec('checkout remote');
        await mg.exec('rm keep.txt');
        await mg.exec('add .');
        await mg.exec('commit -m "remote deletes keep"');
        const remote = await mg.resolveRef('HEAD');
        await mg.exec('checkout main');

        await mg.merge(remote, { strategy: 'theirs' });
        await expect(mg.readFile('keep.txt')).rejects.toBeDefined();
    });

    it('file<->directory type conflict → ours wins, no MergeNotSupportedError', async () => {
        const mg = await fresh('typeconflict');
        await mg.writeFile('config', 'iam-a-file\n'); // ours: file
        await mg.exec('add .');
        await mg.exec('commit -m local');
        const remote = await orphanRef(mg, 'remote', [{ path: 'config/app.json', content: 'remote\n' }]); // theirs: dir

        const result = await mg.merge(remote, { strategy: 'ours', allowUnrelatedHistories: true });
        expect(result.oid).toBeTruthy();
        expect(await mg.readFile('config')).toBe('iam-a-file\n');
    });

    it('faithful 3-way: non-conflicting theirs change is kept (not ours-wins-all)', async () => {
        const mg = await diverged('threeway', { 'a.txt': 'base-a\n', 'b.txt': 'base-b\n' });
        await mg.writeFile('a.txt', 'ours-a\n'); // ours changes a only
        await mg.exec('add .');
        await mg.exec('commit -m ours');
        await mg.exec('checkout remote');
        await mg.writeFile('b.txt', 'theirs-b\n'); // theirs changes b only
        await mg.exec('add .');
        await mg.exec('commit -m theirs');
        const remote = await mg.resolveRef('HEAD');
        await mg.exec('checkout main');

        await mg.merge(remote, { strategy: 'ours' });
        expect(await mg.readFile('a.txt')).toBe('ours-a\n');   // ours' change
        expect(await mg.readFile('b.txt')).toBe('theirs-b\n'); // theirs' non-conflicting change kept
    });

    it('true content conflict resolves to the chosen side', async () => {
        const mg = await diverged('conflict', { 's.txt': 'base\n' });
        await mg.writeFile('s.txt', 'ours\n');
        await mg.exec('add .');
        await mg.exec('commit -m ours');
        await mg.exec('checkout remote');
        await mg.writeFile('s.txt', 'theirs\n');
        await mg.exec('add .');
        await mg.exec('commit -m theirs');
        const remote = await mg.resolveRef('HEAD');
        await mg.exec('checkout main');

        await mg.merge(remote, { strategy: 'ours' });
        expect(await mg.readFile('s.txt')).toBe('ours\n');
    });

    it('mirrors the pods-manager GitHub-sync command exactly (unrelated, nested)', async () => {
        const mg = await fresh('podsync');
        await mg.writeFile('package.json', '{"name":"local"}\n');
        await mg.writeFile('src/components/cadastros/EmployeeTable.tsx', 'LOCAL\n');
        await mg.exec('add .');
        await mg.exec('commit -m local');
        const remote = await orphanRef(mg, 'remote', [
            { path: 'README.md', content: '# remote\n' },
            { path: 'src/components/cadastros/EmployeeTable.tsx', content: 'REMOTE\n' },
            { path: 'src/components/cadastros/EmployeesTab.tsx', content: 'REMOTE tab\n' },
        ]);
        mg.fs.writeFileSync(`${mg.dir}/.git/FETCH_HEAD`, `${remote}\t\thttps://github.com/x/y.git\n`);

        // exact pods-manager pullFromRemote command
        await mg.exec('merge FETCH_HEAD --no-edit --strategy-option=ours --allow-unrelated-histories');

        expect(await mg.readFile('src/components/cadastros/EmployeeTable.tsx')).toBe('LOCAL\n'); // ours wins
        expect(await mg.readFile('src/components/cadastros/EmployeesTab.tsx')).toBe('REMOTE tab\n'); // remote-only kept
        expect(await mg.readFile('README.md')).toBe('# remote\n'); // remote-only kept
    });

    it('already up to date when theirs is an ancestor of ours', async () => {
        const mg = await fresh('uptodate');
        await mg.writeFile('a.txt', '1\n');
        await mg.exec('add .');
        await mg.exec('commit -m c1');
        const old = await mg.resolveRef('HEAD');
        await mg.writeFile('a.txt', '2\n');
        await mg.exec('add .');
        await mg.exec('commit -m c2');

        const result = await mg.merge(old, { strategy: 'ours' });
        expect(result.alreadyMerged).toBe(true);
        expect(await mg.readFile('a.txt')).toBe('2\n');
    });

    it('fast-forwards when ours is an ancestor of theirs', async () => {
        const mg = await fresh('ff');
        await mg.writeFile('a.txt', '1\n');
        await mg.exec('add .');
        await mg.exec('commit -m c1');
        await mg.exec('branch remote');
        await mg.exec('checkout remote');
        await mg.writeFile('a.txt', '2\n');
        await mg.writeFile('new.txt', 'new\n');
        await mg.exec('add .');
        await mg.exec('commit -m c2');
        const remote = await mg.resolveRef('HEAD');
        await mg.exec('checkout main');

        const result = await mg.merge(remote, { strategy: 'ours' });
        expect(result.fastForward).toBe(true);
        expect(await mg.readFile('a.txt')).toBe('2\n');     // theirs (ff target)
        expect(await mg.readFile('new.txt')).toBe('new\n');
    });
});
