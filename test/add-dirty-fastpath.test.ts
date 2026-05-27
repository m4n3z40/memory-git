import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { MemoryGit } from '../src/index';

/**
 * Phase 1 (memory plan): add('.') fast-path correctness + cost.
 *
 *  - Loading a committed checkout must NOT re-seed every file: add('.') stays a
 *    no-op until something is written in memory (the old blanket seed forced a
 *    full re-hash + index rewrite on the first add).
 *  - Writes that bypass writeFile()/deleteFile() — a build writing through the
 *    volume, i.e. toJustBashFs(mg) — must be staged by add('.') (previously
 *    silently dropped because they never reached _dirtyFiles).
 *  - A fresh import (unborn HEAD) must still seed the whole tree.
 */

/** Build a committed git repo on disk by flushing an in-memory one. */
async function committedRepoOnDisk(dir: string): Promise<void> {
    const seed = new MemoryGit('seed');
    seed.setAuthor('a', 'a@a');
    await seed.init();
    await seed.writeFile('a.txt', '1');
    await seed.writeFile('b.txt', '2');
    await seed.add('.');
    await seed.commit('init');
    await seed.flush(dir);
}

describe("add('.') dirty fast-path", () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mg-addfast-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('loading a committed checkout leaves add(".") a no-op (no re-stage)', async () => {
        await committedRepoOnDisk(dir);

        const mg = new MemoryGit('loaded');
        mg.setAuthor('a', 'a@a');
        await mg.loadFromDisk(dir);
        expect(mg.isDirty()).toBe(false);

        // No in-memory writes → nothing to stage. Old behavior seeded every
        // file and rewrote .git/index here, flipping isDirty to true.
        await mg.add('.');
        expect(mg.isDirty()).toBe(false);
        expect(mg.getDirtyPaths().filter(p => !p.startsWith('.git/'))).toEqual([]);
    });

    it('stages files written through the volume (the toJustBashFs build path)', async () => {
        await committedRepoOnDisk(dir);

        const mg = new MemoryGit('build');
        mg.setAuthor('a', 'a@a');
        await mg.loadFromDisk(dir);

        // Mimic a build writing straight to the volume (what toJustBashFs(mg)
        // wraps): a NEW file plus a modification, neither via writeFile().
        await mg.volume.promises.writeFile(`${mg.dir}/built.txt`, 'fresh artifact');
        await mg.volume.promises.writeFile(`${mg.dir}/a.txt`, 'modified');

        // The recorder routed both into the add('.') fast-path.
        expect(mg.getDirtyPaths()).toEqual(
            expect.arrayContaining(['built.txt', 'a.txt']),
        );

        await mg.add('.');
        const staged = (await mg.status()).filter(s => s.stage === 2 || s.stage === 3);
        const stagedNames = staged.map(s => s.filepath);
        expect(stagedNames).toContain('built.txt'); // the bug: previously missed
        expect(stagedNames).toContain('a.txt');

        await mg.commit('build output');
        expect(await mg.readFileAtRef('built.txt', 'HEAD')).toBe('fresh artifact');
    });

    it('fresh import (unborn HEAD) still seeds the whole tree for add(".")', async () => {
        // Repo with files but no commit → HEAD is unborn.
        const seed = new MemoryGit('seed-uncommitted');
        seed.setAuthor('a', 'a@a');
        await seed.init();
        await seed.writeFile('x.txt', 'hello');
        await seed.flush(dir);

        const mg = new MemoryGit('import');
        mg.setAuthor('a', 'a@a');
        await mg.loadFromDisk(dir);

        // Nothing written in memory, yet add('.') must pick up the whole tree.
        await mg.add('.');
        const sha = await mg.commit('first');
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        expect(await mg.readFileAtRef('x.txt', 'HEAD')).toBe('hello');
    });

    it('{stageWorkingTree:true} force-seeds a loaded committed checkout', async () => {
        await committedRepoOnDisk(dir);

        const mg = new MemoryGit('forced');
        mg.setAuthor('a', 'a@a');
        await mg.loadFromDisk(dir, { stageWorkingTree: true });

        // Seeded → add('.') re-stages, rewriting .git/index → dirty.
        await mg.add('.');
        expect(mg.isDirty()).toBe(true);
    });
});
