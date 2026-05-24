import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { MemoryGit } from '../src/index';

/**
 * Helper: create a real on-disk git repo with a few files and commits.
 */
async function createRealRepo(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    execSync('git init -q -b main', { cwd: dir });
    execSync('git config user.email "test@test"', { cwd: dir });
    execSync('git config user.name  "test"',       { cwd: dir });
    await fs.writeFile(path.join(dir, 'README.md'), '# hello\n');
    await fs.writeFile(path.join(dir, 'a.txt'),     'aaa\n');
    await fs.writeFile(path.join(dir, 'b.txt'),     'bbb\n');
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'sub/c.txt'), 'ccc\n');
    execSync('git add -A',                          { cwd: dir });
    execSync('git commit -q -m initial',            { cwd: dir });
    await fs.writeFile(path.join(dir, 'b.txt'),     'bbb-v2\n');
    execSync('git commit -q -am v2',                { cwd: dir });
}

/**
 * Strip MemoryGit's repo prefix off paths from `vol.toJSON()` so assertions
 * read naturally. Returns repo-relative paths whose entries are non-null
 * (memfs dumps null for directories; we only care about files).
 */
function filesInMemory(memGit: MemoryGit): string[] {
    const snap = memGit.vol.toJSON() as Record<string, string | null>;
    const prefix = `${memGit.dir}/`;
    return Object.entries(snap)
        .filter(([, v]) => v !== null)
        .map(([k]) => (k.startsWith(prefix) ? k.slice(prefix.length) : k))
        .sort();
}

describe('lazy mode', () => {
    let realDir: string;
    let memGit: MemoryGit;

    beforeEach(async () => {
        realDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-lazy-'));
        await createRealRepo(realDir);
        memGit = new MemoryGit('lazy-test', { lazy: true });
    });

    afterEach(async () => {
        try { await fs.rm(realDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('loads no file contents into memfs after loadFromDisk', async () => {
        const count = await memGit.loadFromDisk(realDir);
        expect(count).toBeGreaterThan(0);
        // memfs should only have dir entries — no file bytes anywhere.
        expect(filesInMemory(memGit)).toEqual([]);
    });

    it('materializes only the file the caller reads', async () => {
        await memGit.loadFromDisk(realDir);
        const a = await memGit.readFile('a.txt');
        expect(a).toBe('aaa\n');

        const loaded = filesInMemory(memGit);
        expect(loaded).toContain('a.txt');
        // b.txt and sub/c.txt were never touched — still lazy.
        expect(loaded).not.toContain('b.txt');
        expect(loaded).not.toContain('sub/c.txt');
    });

    it('readdir returns lazy children alongside materialized ones', async () => {
        await memGit.loadFromDisk(realDir);
        const files = await memGit.listFiles();
        expect(files.sort()).toEqual(['README.md', 'a.txt', 'b.txt', 'sub/c.txt']);
        // None of those should have been forced into memfs by readdir.
        expect(filesInMemory(memGit)).toEqual([]);
    });

    it('git log works in lazy mode (faults in only the packs/objects it needs)', async () => {
        await memGit.loadFromDisk(realDir);
        const commits = await memGit.log();
        expect(commits.length).toBe(2);
        expect(commits[0].message).toMatch(/v2/);
        // Working-tree files should still be lazy; only .git/ paths got faulted in.
        const loaded = filesInMemory(memGit);
        expect(loaded).not.toContain('a.txt');
        expect(loaded).not.toContain('b.txt');
    });

    it('flush() is incremental: untouched lazy files are not re-written to disk', async () => {
        await memGit.loadFromDisk(realDir);
        // Mutate one file in memory.
        await memGit.writeFile('a.txt', 'aaa-modified\n');

        // Capture pre-flush mtimes for files we did NOT touch.
        const bMtimeBefore = (await fs.stat(path.join(realDir, 'b.txt'))).mtimeMs;
        const cMtimeBefore = (await fs.stat(path.join(realDir, 'sub/c.txt'))).mtimeMs;

        // Slight pause so a re-write would show up as a different mtime.
        await new Promise(r => setTimeout(r, 20));
        const written = await memGit.flush();
        expect(written).toBe(1);

        const bMtimeAfter = (await fs.stat(path.join(realDir, 'b.txt'))).mtimeMs;
        const cMtimeAfter = (await fs.stat(path.join(realDir, 'sub/c.txt'))).mtimeMs;
        expect(bMtimeAfter).toBe(bMtimeBefore);
        expect(cMtimeAfter).toBe(cMtimeBefore);

        // The modified file IS on disk with the new content.
        const aOnDisk = await fs.readFile(path.join(realDir, 'a.txt'), 'utf8');
        expect(aOnDisk).toBe('aaa-modified\n');
    });

    it('deleting a lazy file in memory removes it from disk on flush', async () => {
        await memGit.loadFromDisk(realDir);
        // Delete a file that was never materialized.
        await memGit.deleteFile('b.txt');
        // Sanity: a subsequent read sees the deletion.
        expect(await memGit.fileExists('b.txt')).toBe(false);

        await memGit.flush();
        const stillThere = await fs.access(path.join(realDir, 'b.txt')).then(() => true, () => false);
        expect(stillThere).toBe(false);
    });

    it('writing to a lazy path overrides the on-disk content (no re-fault clobber)', async () => {
        await memGit.loadFromDisk(realDir);
        // Overwrite a still-lazy file in memory.
        await memGit.writeFile('b.txt', 'new-content\n');
        // Reading should return what we just wrote, not what's on disk.
        const back = await memGit.readFile('b.txt');
        expect(back).toBe('new-content\n');
    });

    it('non-lazy instance still loads everything eagerly', async () => {
        const eager = new MemoryGit('eager-test'); // no lazy flag
        const count = await eager.loadFromDisk(realDir);
        expect(count).toBeGreaterThan(0);
        // Eager load: all four working-tree files are bytes-in-memory.
        const loaded = filesInMemory(eager);
        expect(loaded).toContain('a.txt');
        expect(loaded).toContain('b.txt');
        expect(loaded).toContain('sub/c.txt');
        expect(loaded).toContain('README.md');
    });
});
