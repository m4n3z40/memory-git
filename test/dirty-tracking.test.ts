import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { MemoryGit } from '../src/index';

async function seeded(name: string, lazy = true): Promise<MemoryGit> {
    const mg = new MemoryGit(name, { lazy });
    mg.setAuthor('a', 'a@a');
    await mg.init();
    await mg.writeFile('a.txt', 'x');
    await mg.exec('git add .');
    await mg.exec('git commit -m v1');
    return mg;
}

describe('dirty tracking (isDirty / getDirtyPaths)', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mg-dirty-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('(a) commit + tag count as dirty without a working-tree write; flush clears', async () => {
        const mg = await seeded('a');
        await mg.exec('git tag v0.0.1');

        expect(mg.isDirty()).toBe(true);
        expect(mg.getDirtyPaths().some(p => p.includes('refs/tags/v0.0.1'))).toBe(true);

        await mg.flush(dir);
        expect(mg.isDirty()).toBe(false);
        expect(mg.getDirtyPaths()).toEqual([]);
    });

    it('(b) critical: a lone tag on a flushed instance marks dirty', async () => {
        const mg = await seeded('b');
        await mg.flush(dir);
        expect(mg.isDirty()).toBe(false);

        await mg.exec('git tag v0.0.2'); // ONLY a tag — no working-tree write
        expect(mg.isDirty()).toBe(true);
        expect(mg.getDirtyPaths().some(p => p.includes('refs/tags/v0.0.2'))).toBe(true);

        await mg.flush(dir);
        expect(mg.isDirty()).toBe(false);
    });

    it('a lone commit (only .git writes) marks dirty', async () => {
        const mg = await seeded('commit');
        await mg.writeFile('a.txt', 'y');
        await mg.flush(dir); // persist the working-tree edit, leave it uncommitted
        expect(mg.isDirty()).toBe(false);

        await mg.exec('git add .');
        await mg.exec('git commit -m v2'); // writes only .git objects/refs/index
        expect(mg.isDirty()).toBe(true);
        expect(mg.getDirtyPaths().some(p => p.startsWith('.git/'))).toBe(true);
    });

    it('deleting a tag (ref unlink) marks dirty', async () => {
        const mg = await seeded('del');
        await mg.exec('git tag v0.0.1');
        await mg.flush(dir);
        expect(mg.isDirty()).toBe(false);

        await mg.exec('git tag -d v0.0.1');
        expect(mg.isDirty()).toBe(true);
        await mg.flush(dir);
        expect(mg.isDirty()).toBe(false);
    });

    it('loadFromDisk leaves the instance clean, and reads (lazy faulting) stay clean', async () => {
        const seed = await seeded('seed');
        await seed.exec('git tag v0.0.1');
        await seed.flush(dir);

        const mg = new MemoryGit('hydrated', { lazy: true });
        await mg.loadFromDisk(dir);
        expect(mg.isDirty()).toBe(false);

        // Faulting refs/objects in from disk must NOT be recorded as a mutation.
        await mg.exec('git log --oneline');
        await mg.listTags();
        expect(mg.isDirty()).toBe(false);
    });

    it('working-tree writes are tracked repo-relative', async () => {
        const mg = await seeded('wt');
        await mg.flush(dir);
        expect(mg.isDirty()).toBe(false);

        await mg.writeFile('src/app.tsx', 'export {}');
        expect(mg.isDirty()).toBe(true);
        expect(mg.getDirtyPaths()).toContain('src/app.tsx');
    });

    it('works in non-lazy (eager) mode too', async () => {
        const mg = new MemoryGit('eager'); // no lazy flag
        mg.setAuthor('a', 'a@a');
        await mg.init();
        expect(mg.isDirty()).toBe(true); // fresh init skeleton is unpersisted

        await mg.flush(dir);
        expect(mg.isDirty()).toBe(false);

        await mg.writeFile('a.txt', 'x');
        expect(mg.isDirty()).toBe(true);
        expect(mg.getDirtyPaths()).toContain('a.txt');
    });

    it('flush only clears paths dirty at flush start (writes during/after stay dirty)', async () => {
        const mg = await seeded('partial');
        await mg.flush(dir);
        await mg.exec('git tag v0.0.1');
        await mg.flush(dir);
        await mg.exec('git tag v0.0.2'); // after the flush
        expect(mg.isDirty()).toBe(true);
        expect(mg.getDirtyPaths().some(p => p.includes('refs/tags/v0.0.2'))).toBe(true);
    });

    it('clear() resets the dirty state', async () => {
        const mg = await seeded('clear');
        expect(mg.isDirty()).toBe(true);
        await mg.clear();
        expect(mg.isDirty()).toBe(false);
        expect(mg.getDirtyPaths()).toEqual([]);
    });
});
