/**
 * Crash-safety coverage for the atomic flush write (SKP-737).
 *
 * Host crashes (Exit 134 V8-abort / Exit 137 cgroup-OOM) killed the process
 * mid-flush. The old memory→disk path used plain writeFile, which truncates
 * the target to 0 before writing the new bytes — a kill in that window left
 * .git/HEAD, .git/index, loose objects, packfiles and refs zeroed/partial,
 * corrupting prod repos. atomicWriteFile writes a sibling temp then rename(2)s
 * over the target, so a mid-flush kill leaves the target either intact-old or
 * intact-new, never truncated. The orphan temp left by a kill BEFORE the
 * rename must never be loaded back into memfs as a tracked file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodeFs from 'fs';
import { promises as fsRealAsync } from 'fs';
import os from 'os';
import path from 'path';
import { createFsFromVolume, Volume } from 'memfs';
import ignore from 'ignore';
import {
    atomicWriteFile,
    isFlushTempName,
    copyDiskToMemory,
    copyDiskToMemoryIncremental,
    copyMemoryToDisk,
    copyMemoryToDiskIncremental,
    listFilesRecursive,
    type FileFingerprint,
} from '../src/disk-sync';
import { MemoryGit } from '../src/index';

const hasTemp = async (dir: string) =>
    (await fsRealAsync.readdir(dir)).some(isFlushTempName);

describe('atomicWriteFile (unit)', () => {
    let tmp: string;

    beforeEach(async () => {
        tmp = await fsRealAsync.mkdtemp(path.join(os.tmpdir(), 'mg-atomic-'));
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await fsRealAsync.rm(tmp, { recursive: true, force: true });
    });

    it('round-trips content and leaves no temp behind', async () => {
        const target = path.join(tmp, 'file.txt');
        await atomicWriteFile(target, Buffer.from('hello world'));

        expect(await fsRealAsync.readFile(target, 'utf8')).toBe('hello world');
        expect(await hasTemp(tmp)).toBe(false);
    });

    it('overwrites an existing target atomically', async () => {
        const target = path.join(tmp, 'file.txt');
        await fsRealAsync.writeFile(target, 'old');
        await atomicWriteFile(target, Buffer.from('new'));

        expect(await fsRealAsync.readFile(target, 'utf8')).toBe('new');
        expect(await hasTemp(tmp)).toBe(false);
    });

    it('NON-TRUNCATION: a rename failure leaves the old target intact and removes the temp', async () => {
        const target = path.join(tmp, 'HEAD');
        await fsRealAsync.writeFile(target, 'ref: refs/heads/main\n');

        // Simulate the process surviving the temp write but rename failing
        // (the spec's mock for "kill during rename"): the target must keep its
        // OLD bytes — never the truncated/empty state the old writeFile left.
        vi.spyOn(nodeFs.promises, 'rename').mockRejectedValueOnce(
            new Error('simulated rename failure'),
        );

        await expect(
            atomicWriteFile(target, Buffer.from('CORRUPT')),
        ).rejects.toThrow('simulated rename failure');

        // Old content fully intact (the whole point — no truncation).
        expect(await fsRealAsync.readFile(target, 'utf8')).toBe('ref: refs/heads/main\n');
        // And the temp was cleaned up, not orphaned.
        expect(await hasTemp(tmp)).toBe(false);
    });

    it('isFlushTempName recognises the temp infix', () => {
        expect(isFlushTempName('HEAD.mg-flush-tmp-123-abc')).toBe(true);
        expect(isFlushTempName('HEAD')).toBe(false);
        expect(isFlushTempName('index')).toBe(false);
    });
});

describe('orphan flush-temp: never loaded into memfs AND reaped from disk (unit)', () => {
    let tmp: string;
    const orphan = 'real.txt.mg-flush-tmp-99-deadbeef';

    beforeEach(async () => {
        tmp = await fsRealAsync.mkdtemp(path.join(os.tmpdir(), 'mg-orphan-'));
    });
    afterEach(async () => {
        await fsRealAsync.rm(tmp, { recursive: true, force: true });
    });

    it('copyDiskToMemory skips the orphan in memfs and reaps it from disk', async () => {
        await fsRealAsync.writeFile(path.join(tmp, 'real.txt'), 'keep');
        await fsRealAsync.writeFile(path.join(tmp, orphan), 'junk');

        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo', { recursive: true });
        const count = await copyDiskToMemory(fs as any, tmp, '/repo', ignore(), '');

        expect(count).toBe(1);
        const files = listFilesRecursive(fs as any, '/repo');
        expect(files).toContain('real.txt');
        expect(files.some(isFlushTempName)).toBe(false);
        // The orphan is gone from disk; the real file is untouched.
        expect(await hasTemp(tmp)).toBe(false);
        expect(await fsRealAsync.readFile(path.join(tmp, 'real.txt'), 'utf8')).toBe('keep');
    });

    it('copyDiskToMemoryIncremental skips the orphan in memfs and reaps it from disk', async () => {
        await fsRealAsync.writeFile(path.join(tmp, 'real.txt'), 'keep');
        await fsRealAsync.writeFile(path.join(tmp, orphan), 'junk');

        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo', { recursive: true });
        const snapshot = new Map<string, FileFingerprint>();
        const seen = new Set<string>();
        const { read } = await copyDiskToMemoryIncremental(
            fs as any, tmp, '/repo', ignore(), '', snapshot, seen,
        );

        expect(read).toBe(1);
        expect(seen.has('real.txt')).toBe(true);
        expect([...seen].some(isFlushTempName)).toBe(false);
        expect(listFilesRecursive(fs as any, '/repo').some(isFlushTempName)).toBe(false);
        expect(await hasTemp(tmp)).toBe(false);
    });

    it('loadFromDisk does not surface the orphan and reaps it from disk', async () => {
        await fsRealAsync.writeFile(path.join(tmp, 'real.txt'), 'keep');
        await fsRealAsync.writeFile(path.join(tmp, orphan), 'junk');

        const mg = new MemoryGit('orphan-load');
        await mg.loadFromDisk(tmp);

        const files = await mg.listFiles('', true);
        expect(files).toContain('real.txt');
        expect(files.some(isFlushTempName)).toBe(false);
        expect(await hasTemp(tmp)).toBe(false);
    });

    it('lazy loadFromDisk does not index the orphan and reaps it from disk', async () => {
        await fsRealAsync.writeFile(path.join(tmp, 'real.txt'), 'keep');
        await fsRealAsync.writeFile(path.join(tmp, orphan), 'junk');

        const mg = new MemoryGit('orphan-lazy', { lazy: true });
        await mg.loadFromDisk(tmp);

        const files = await mg.listFiles('', true);
        expect(files).toContain('real.txt');
        expect(files.some(isFlushTempName)).toBe(false);
        expect(await hasTemp(tmp)).toBe(false);
    });

    it('reaps a nested orphan (inside a subdir) without touching siblings', async () => {
        await fsRealAsync.mkdir(path.join(tmp, '.git'), { recursive: true });
        await fsRealAsync.writeFile(path.join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        await fsRealAsync.writeFile(path.join(tmp, '.git', 'HEAD.mg-flush-tmp-7-abc123'), 'partial');

        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo', { recursive: true });
        await copyDiskToMemory(fs as any, tmp, '/repo', ignore(), '');

        expect(await hasTemp(path.join(tmp, '.git'))).toBe(false);
        expect(await fsRealAsync.readFile(path.join(tmp, '.git', 'HEAD'), 'utf8'))
            .toBe('ref: refs/heads/main\n');
    });
});

describe('flush regression: every file still written (unit)', () => {
    let tmp: string;

    beforeEach(async () => {
        tmp = await fsRealAsync.mkdtemp(path.join(os.tmpdir(), 'mg-flush-'));
    });
    afterEach(async () => {
        await fsRealAsync.rm(tmp, { recursive: true, force: true });
    });

    it('copyMemoryToDisk (full) writes all files with correct content and no temps', async () => {
        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo/sub', { recursive: true });
        fs.writeFileSync('/repo/a.txt', 'A');
        fs.writeFileSync('/repo/sub/b.txt', 'B');

        const count = await copyMemoryToDisk(fs as any, '/repo', tmp);

        expect(count).toBe(2);
        expect(await fsRealAsync.readFile(path.join(tmp, 'a.txt'), 'utf8')).toBe('A');
        expect(await fsRealAsync.readFile(path.join(tmp, 'sub/b.txt'), 'utf8')).toBe('B');
        expect(await hasTemp(tmp)).toBe(false);
    });

    it('copyMemoryToDiskIncremental writes changed files, skips unchanged, leaves no temps', async () => {
        const fs = createFsFromVolume(new Volume());
        fs.mkdirSync('/repo', { recursive: true });
        fs.writeFileSync('/repo/a.txt', 'A');
        fs.writeFileSync('/repo/b.txt', 'B');

        const snapshot = new Map<string, FileFingerprint>();
        const first = await copyMemoryToDiskIncremental(fs as any, '/repo', tmp, '', snapshot, new Set());
        expect(first.written).toBe(2);
        expect(await fsRealAsync.readFile(path.join(tmp, 'a.txt'), 'utf8')).toBe('A');
        expect(await fsRealAsync.readFile(path.join(tmp, 'b.txt'), 'utf8')).toBe('B');

        // Mutate one file; re-flush must rewrite only it.
        fs.writeFileSync('/repo/a.txt', 'A2');
        const second = await copyMemoryToDiskIncremental(fs as any, '/repo', tmp, '', snapshot, new Set());
        expect(second.written).toBe(1);
        expect(second.skipped).toBe(1);
        expect(await fsRealAsync.readFile(path.join(tmp, 'a.txt'), 'utf8')).toBe('A2');
        expect(await hasTemp(tmp)).toBe(false);
    });

    it('MemoryGit round-trip: commit → flush → native files match', async () => {
        const mg = new MemoryGit('flush-roundtrip');
        await mg.init();
        await mg.writeFile('hello.txt', 'world');
        await mg.add('hello.txt');
        await mg.commit('add hello');

        await mg.flush(tmp);

        expect(await fsRealAsync.readFile(path.join(tmp, 'hello.txt'), 'utf8')).toBe('world');
        // No orphan temps anywhere in the flushed tree, including .git/.
        const walk = async (dir: string): Promise<string[]> => {
            const out: string[] = [];
            for (const e of await fsRealAsync.readdir(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) out.push(...await walk(full));
                else out.push(e.name);
            }
            return out;
        };
        expect((await walk(tmp)).some(isFlushTempName)).toBe(false);
    });
});
