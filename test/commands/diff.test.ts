import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryGit } from '../../src/index';

describe('exec("diff") --diff-filter', () => {
    let mg: MemoryGit;
    let base: string;

    beforeEach(async () => {
        mg = new MemoryGit('diff-filter-test');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');

        await mg.writeFile('keep.txt', 'keep-v1');
        await mg.writeFile('modify-me.txt', 'orig');
        await mg.writeFile('delete-me.txt', 'doomed');
        await mg.exec('add .');
        await mg.exec('commit -m base');
        base = await mg.resolveRef('HEAD');

        await mg.writeFile('new-file.txt', 'fresh');
        await mg.writeFile('modify-me.txt', 'changed');
        await mg.deleteFile('delete-me.txt');
        await mg.exec('add -A');
        await mg.exec('commit -m mutate');
    });

    it('keeps only added entries with --diff-filter=A', async () => {
        const out = await mg.exec(`diff --name-only --diff-filter=A ${base} HEAD`);
        expect(out.split('\n').sort()).toEqual(['new-file.txt']);
    });

    it('keeps only deleted entries with --diff-filter=D', async () => {
        const out = await mg.exec(`diff --name-only --diff-filter=D ${base} HEAD`);
        expect(out.split('\n').sort()).toEqual(['delete-me.txt']);
    });

    it('keeps only modified entries with --diff-filter=M', async () => {
        const out = await mg.exec(`diff --name-only --diff-filter=M ${base} HEAD`);
        expect(out.split('\n').sort()).toEqual(['modify-me.txt']);
    });

    it('accepts combined codes like --diff-filter=AM (excludes deleted)', async () => {
        const out = await mg.exec(`diff --name-only --diff-filter=AM ${base} HEAD`);
        expect(out.split('\n').sort()).toEqual(['modify-me.txt', 'new-file.txt']);
    });

    it('returns every entry when no filter is provided', async () => {
        const out = await mg.exec(`diff --name-only ${base} HEAD`);
        expect(out.split('\n').sort()).toEqual([
            'delete-me.txt',
            'modify-me.txt',
            'new-file.txt',
        ]);
    });

    it('is case-insensitive on the filter codes', async () => {
        const out = await mg.exec(`diff --name-only --diff-filter=a ${base} HEAD`);
        expect(out).toBe('new-file.txt');
    });
});

describe('exec("diff --quiet")', () => {
    let mg: MemoryGit;

    beforeEach(async () => {
        mg = new MemoryGit('diff-quiet-test');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');
    });

    it('returns empty string when the working tree is clean', async () => {
        const out = await mg.exec('diff --quiet');
        expect(out).toBe('');
    });

    it('throws with exitCode=1 when there are unstaged changes', async () => {
        await mg.writeFile('new.txt', 'fresh');
        try {
            await mg.exec('diff --quiet');
            throw new Error('expected exec to throw');
        } catch (err: unknown) {
            const e = err as Error & { exitCode?: number };
            expect(e.exitCode).toBe(1);
            expect(e.message).toMatch(/changes present/);
        }
    });

    it('accepts -q as an alias for --quiet', async () => {
        await mg.writeFile('new.txt', 'fresh');
        await expect(mg.exec('diff -q')).rejects.toMatchObject({ exitCode: 1 });
    });

    it('respects --cached: clean when index matches HEAD even with new workdir files', async () => {
        await mg.writeFile('untracked.txt', 'x'); // workdir-only, not staged
        const out = await mg.exec('diff --quiet --cached');
        expect(out).toBe('');
    });

    it('combines with --diff-filter: clean when only excluded statuses changed', async () => {
        // Only an Added file in workdir; filter excludes A → effectively clean
        await mg.writeFile('new.txt', 'x');
        const out = await mg.exec('diff --quiet --diff-filter=M');
        expect(out).toBe('');
        // Without the filter, the new file makes it dirty
        await expect(mg.exec('diff --quiet')).rejects.toMatchObject({ exitCode: 1 });
    });
});

describe('mg.hasDiff', () => {
    it('mirrors diff().length > 0 across cached and ref-based modes', async () => {
        const mg = new MemoryGit('has-diff-api');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');
        const base = await mg.resolveRef('HEAD');

        expect(await mg.hasDiff()).toBe(false);
        expect(await mg.hasDiff({ cached: true })).toBe(false);

        // Use a new file (not modifying tracked content) to avoid hitting
        // isomorphic-git's stat-cache shortcut for same-size workdir edits.
        await mg.writeFile('b.txt', 'fresh');
        expect(await mg.hasDiff()).toBe(true);
        expect(await mg.hasDiff({ cached: true })).toBe(false);

        await mg.exec('add .');
        expect(await mg.hasDiff({ cached: true })).toBe(true);

        await mg.exec('commit -m next');
        expect(await mg.hasDiff({ fromRef: base, toRef: 'HEAD' })).toBe(true);
        expect(await mg.hasDiff({ fromRef: 'HEAD', toRef: 'HEAD' })).toBe(false);
    });
});

describe('mg.diff stat-cache workaround', () => {
    it('detects same-size workdir edits on tracked files', async () => {
        const mg = new MemoryGit('diff-same-size');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');
        await mg.writeFile('a.txt', 'x');
        await mg.exec('add .');
        await mg.exec('commit -m init');

        // Same-size edit ('x' → 'y') would slip past statusMatrix's
        // mtime-second + size shortcut without the dirty-file re-hash.
        await mg.writeFile('a.txt', 'y');
        const entries = await mg.diff();
        expect(entries.map(e => e.filepath)).toContain('a.txt');
        expect(await mg.hasDiff()).toBe(true);
    });

    it('stays clean when a dirty file is restored to its committed content', async () => {
        const mg = new MemoryGit('diff-restore');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');
        await mg.writeFile('a.txt', 'x');
        await mg.exec('add .');
        await mg.exec('commit -m init');

        // Touch the file but write the same bytes back — workdir still matches HEAD
        await mg.writeFile('a.txt', 'x');
        expect(await mg.hasDiff()).toBe(false);
    });

    it('treats deleted-via-API files as workdir-absent', async () => {
        const mg = new MemoryGit('diff-deleted');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');
        await mg.writeFile('a.txt', 'x');
        await mg.exec('add .');
        await mg.exec('commit -m init');

        await mg.deleteFile('a.txt');
        expect(await mg.hasDiff()).toBe(true);
    });

    it('mg.exec("diff HEAD") reports workdir vs HEAD, not HEAD vs HEAD', async () => {
        const mg = new MemoryGit('diff-vs-head');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');
        await mg.writeFile('a.txt', 'x');
        await mg.exec('add .');
        await mg.exec('commit -m init');

        // Clean repo: diff HEAD is empty
        expect(await mg.exec('diff --name-only HEAD')).toBe('');

        // After a same-size edit, diff HEAD should list a.txt
        await mg.writeFile('a.txt', 'y');
        const out = await mg.exec('diff --name-only HEAD');
        expect(out).toBe('a.txt');

        // And --quiet HEAD should throw with exitCode=1
        await expect(mg.exec('diff --quiet HEAD')).rejects.toMatchObject({ exitCode: 1 });
    });
});

describe('mg.diff({ filter })', () => {
    it('filters by Added/Modified using the API surface directly', async () => {
        const mg = new MemoryGit('diff-filter-api');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');
        const base = await mg.resolveRef('HEAD');

        await mg.writeFile('a.txt', '2');
        await mg.writeFile('b.txt', 'new');
        await mg.exec('add -A');
        await mg.exec('commit -m next');

        const onlyAdded = await mg.diff({ fromRef: base, toRef: 'HEAD', filter: ['A'] });
        expect(onlyAdded.map(e => e.filepath)).toEqual(['b.txt']);

        const onlyModified = await mg.diff({ fromRef: base, toRef: 'HEAD', filter: ['M'] });
        expect(onlyModified.map(e => e.filepath)).toEqual(['a.txt']);
    });
});
