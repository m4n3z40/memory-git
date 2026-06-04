import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryGit } from '../../src/index';

/**
 * git-parity for `ls-files` and `rm`. The bugs these guard against:
 *  - ls-files used to read the HEAD commit (so `rm --cached` changes were
 *    invisible until the next commit) and ignored pathspecs.
 *  - rm used to accept a single path, had no `-r` recursion, and no
 *    `--ignore-unmatch`.
 */
describe('exec("ls-files") + exec("rm") git parity', () => {
    let mg: MemoryGit;

    beforeEach(async () => {
        mg = new MemoryGit('ls-rm-test');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');
        // Seed: a.txt + a dist/ dir with two files.
        await mg.writeFile('a.txt', 'a');
        await mg.writeFile('dist/x.js', 'x');
        await mg.writeFile('dist/y.js', 'y');
        await mg.exec('add .');
        await mg.exec('commit -m seed');
    });

    describe('ls-files reads the index, not HEAD', () => {
        it('lists files from the index (staging area)', async () => {
            const out = (await mg.exec('ls-files')).split('\n');
            expect(out).toEqual(['a.txt', 'dist/x.js', 'dist/y.js']);
        });

        it('drops a file immediately after rm --cached (HEAD still has it)', async () => {
            await mg.exec('rm --cached a.txt');
            // Index no longer has a.txt...
            expect(await mg.lsFiles()).not.toContain('a.txt');
            // ...but it is still in the HEAD commit (not yet committed).
            expect(await mg.listTrackedFiles('HEAD')).toContain('a.txt');
        });

        it('shows a staged-but-uncommitted file', async () => {
            await mg.writeFile('new.txt', 'n');
            await mg.exec('add new.txt');
            expect(await mg.lsFiles()).toContain('new.txt');
            expect(await mg.listTrackedFiles('HEAD')).not.toContain('new.txt');
        });

        it('does not list untracked files by default', async () => {
            await mg.writeFile('untracked.txt', 'u');
            expect(await mg.lsFiles()).not.toContain('untracked.txt');
        });
    });

    describe('ls-files pathspec filtering', () => {
        it('filters by a directory prefix', async () => {
            const out = (await mg.exec('ls-files dist')).split('\n');
            expect(out).toEqual(['dist/x.js', 'dist/y.js']);
        });

        it('filters by an exact file path', async () => {
            expect(await mg.exec('ls-files a.txt')).toBe('a.txt');
        });

        it('accepts multiple pathspecs (union)', async () => {
            await mg.writeFile('dev-dist/z.js', 'z');
            await mg.exec('add .');
            const out = (await mg.exec('ls-files dist dev-dist')).split('\n');
            expect(out).toEqual(['dev-dist/z.js', 'dist/x.js', 'dist/y.js']);
            expect(out).not.toContain('a.txt');
        });

        it('returns empty for a non-matching pathspec', async () => {
            expect(await mg.exec('ls-files nope')).toBe('');
        });
    });

    describe('ls-files selectors', () => {
        it('-o lists untracked files', async () => {
            await mg.writeFile('untracked.txt', 'u');
            const others = await mg.lsFiles({ others: true });
            expect(others).toContain('untracked.txt');
            expect(others).not.toContain('a.txt');
        });

        it('-m lists modified-but-unstaged files', async () => {
            await mg.writeFile('a.txt', 'changed');
            expect(await mg.lsFiles({ modified: true })).toContain('a.txt');
        });

        it('-d lists files deleted from the working tree', async () => {
            await mg.deleteFile('a.txt');
            expect(await mg.lsFiles({ deleted: true })).toContain('a.txt');
        });
    });

    describe('rm --cached', () => {
        it('removes a single path from the index, keeping the working file', async () => {
            const out = await mg.exec('rm --cached a.txt');
            expect(out).toBe("rm 'a.txt'");
            expect(await mg.lsFiles()).not.toContain('a.txt');
            expect(await mg.fileExists('a.txt')).toBe(true);
        });

        it('removes multiple paths in one call', async () => {
            const out = (await mg.exec('rm --cached dist/x.js dist/y.js')).split('\n');
            expect(out).toEqual(["rm 'dist/x.js'", "rm 'dist/y.js'"]);
            expect(await mg.lsFiles()).toEqual(['a.txt']);
        });
    });

    describe('rm -r (recursive)', () => {
        it('removes every index entry under a directory', async () => {
            await mg.exec('rm -r --cached dist');
            expect(await mg.lsFiles()).toEqual(['a.txt']);
        });

        it('refuses a directory pathspec without -r (git-like error)', async () => {
            await expect(mg.exec('rm --cached dist')).rejects.toThrow(/not removing 'dist' recursively without -r/);
        });
    });

    describe('rm without --cached removes from working tree too', () => {
        it('deletes the working file', async () => {
            await mg.exec('rm a.txt');
            expect(await mg.fileExists('a.txt')).toBe(false);
            expect(await mg.lsFiles()).not.toContain('a.txt');
        });

        it('-r removes a whole directory from index and disk', async () => {
            await mg.exec('rm -r dist');
            expect(await mg.fileExists('dist/x.js')).toBe(false);
            expect(await mg.lsFiles()).toEqual(['a.txt']);
        });
    });

    describe('rm --ignore-unmatch', () => {
        it('exits successfully (no-op) when nothing matches', async () => {
            const out = await mg.exec('rm --cached --ignore-unmatch does-not-exist');
            expect(out).toBe('');
            expect(await mg.lsFiles()).toEqual(['a.txt', 'dist/x.js', 'dist/y.js']);
        });

        it('errors git-like when a pathspec matches nothing without the flag', async () => {
            await expect(mg.exec('rm --cached does-not-exist'))
                .rejects.toThrow(/pathspec 'does-not-exist' did not match any files/);
        });

        it('removes matches and ignores the misses when mixed', async () => {
            const out = await mg.exec('rm --cached --ignore-unmatch a.txt does-not-exist');
            expect(out).toBe("rm 'a.txt'");
            expect(await mg.lsFiles()).not.toContain('a.txt');
        });
    });

    it('minimal repro from the brief passes end-to-end', async () => {
        await mg.exec('rm -r --cached --ignore-unmatch dist'); // no error
        const tracked = await mg.lsFiles();
        expect(tracked).not.toContain('dist/x.js');
        expect(tracked).toContain('a.txt');
        const noop = await mg.exec('rm --cached --ignore-unmatch nao-existe');
        expect(noop).toBe(''); // exit 0, no-op
    });
});
