import { describe, it, expect } from 'vitest';

import { MemoryGit } from '../src/index';

describe('getMemoryUsage breakdown', () => {
    it('splits working tree vs .git and counts binary content by real size', async () => {
        const mg = new MemoryGit('mem');
        mg.setAuthor('a', 'a@a');
        await mg.init();
        await mg.writeFile('text.txt', 'hello world');
        const bin = Buffer.alloc(4096, 7); // binary: old toJSON path counted this as 0
        await mg.writeFile('blob.bin', bin);
        await mg.add('.');
        await mg.commit('c1');

        const u = mg.getMemoryUsage();

        // Totals are internally consistent.
        expect(u.files).toBe(u.breakdown.workingTree.files + u.breakdown.git.files);
        expect(u.estimatedSizeBytes).toBe(
            u.breakdown.workingTree.bytes + u.breakdown.git.bytes,
        );

        // Working tree holds both files and counts the 4096-byte buffer.
        expect(u.breakdown.workingTree.files).toBe(2);
        expect(u.breakdown.workingTree.bytes).toBeGreaterThanOrEqual(4096);

        // A committed repo has a git object store.
        expect(u.breakdown.git.files).toBeGreaterThan(0);
        expect(u.breakdown.git.bytes).toBeGreaterThan(0);
        // Loose objects from the commit, none packed yet.
        expect(u.breakdown.git.looseObjects).toBeGreaterThan(0);
        expect(u.breakdown.git.packBytes).toBe(0);
    });

    it('returns zeros for an uninitialized instance without throwing', () => {
        const mg = new MemoryGit('empty');
        const u = mg.getMemoryUsage();
        expect(u.files).toBe(0);
        expect(u.estimatedSizeBytes).toBe(0);
        expect(u.breakdown.workingTree.bytes).toBe(0);
        expect(u.breakdown.git.bytes).toBe(0);
    });
});

describe('OperationLog maxLogEntries (ring buffer)', () => {
    it('bounds the log and retains the most recent entries', async () => {
        const mg = new MemoryGit('bounded', { maxLogEntries: 5 });
        await mg.init();
        for (let i = 0; i < 20; i++) {
            await mg.writeFile(`f${i}.txt`, String(i));
        }

        const log = mg.getOperationsLog();
        expect(log.length).toBe(5);
        expect(mg.getMemoryUsage().operationsLogged).toBe(5);

        // Tail, not head: the last write recorded must be the most recent.
        const last = log[log.length - 1];
        expect(last.operation).toBe('writeFile');
        expect(last.params.filepath).toBe('f19.txt');
    });

    it('is unbounded by default', async () => {
        const mg = new MemoryGit('unbounded');
        await mg.init();
        for (let i = 0; i < 50; i++) await mg.writeFile(`f${i}.txt`, String(i));
        expect(mg.getOperationsLog().length).toBeGreaterThan(50);
    });
});
