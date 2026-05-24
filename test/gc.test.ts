/**
 * In-memory gc + disk reflection coverage.
 *
 *   - mg.gc() repacks all reachable loose objects, deletes the loose copies
 *     and (by default) consolidates prior packs into the new one.
 *   - flush({clean:true}) propagates the deletions to disk, so a repo that
 *     was gc'd in memory ends up gc'd on disk too.
 *   - Unreachable objects (orphaned by reset --hard) are pruned — there is
 *     no reflog grace period; behavior matches `git gc --prune=now`.
 *   - Native git can read the resulting on-disk repo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsRealAsync } from 'fs';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { MemoryGit } from '../src/index';

const execFile = promisify(execFileCb);
const sh = async (cwd: string, ...args: string[]) =>
    execFile('git', args, {
        cwd,
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });

const countLoose = (mg: MemoryGit): number => {
    const objectsDir = `${mg.dir}/.git/objects`;
    let n = 0;
    let entries: string[];
    try {
        entries = mg.fs.readdirSync(objectsDir) as string[];
    } catch { return 0; }
    for (const name of entries) {
        if (!/^[0-9a-f]{2}$/.test(name)) continue;
        try {
            n += (mg.fs.readdirSync(`${objectsDir}/${name}`) as string[]).length;
        } catch { /* removed mid-iteration */ }
    }
    return n;
};

const listPacks = (mg: MemoryGit): string[] => {
    try {
        return (mg.fs.readdirSync(`${mg.dir}/.git/objects/pack`) as string[])
            .filter(n => n.endsWith('.pack'));
    } catch {
        return [];
    }
};

describe('mg.gc()', () => {
    let mg: MemoryGit;

    beforeEach(async () => {
        mg = new MemoryGit('gc-test');
        await mg.init();
        mg.setAuthor('Test', 't@t');
    });

    it('repacks loose objects into a single pack and clears the loose dir', async () => {
        for (let i = 0; i < 5; i++) {
            await mg.writeFile(`f${i}.txt`, `content-${i}\n`);
            await mg.exec('add .');
            await mg.exec(`commit -m c${i}`);
        }
        const looseBefore = countLoose(mg);
        expect(looseBefore).toBeGreaterThan(0);

        const result = await mg.gc();

        expect(result.reachableObjects).toBeGreaterThan(0);
        expect(result.looseDeleted).toBe(looseBefore);
        expect(result.packFilename).toMatch(/^pack-[0-9a-f]+\.pack$/);
        expect(result.packSizeBytes).toBeGreaterThan(0);
        expect(countLoose(mg)).toBe(0);
        expect(listPacks(mg)).toEqual([result.packFilename]);
    });

    it('keeps the repo readable after gc — log, show, checkout still work', async () => {
        await mg.writeFile('a.txt', 'one');
        await mg.exec('add .');
        await mg.exec('commit -m first');
        await mg.writeFile('a.txt', 'two');
        await mg.exec('add .');
        await mg.exec('commit -m second');

        await mg.gc();

        const log = await mg.exec('log --oneline');
        expect(log.split('\n')).toHaveLength(2);
        const head = await mg.resolveRef('HEAD');
        const show = await mg.exec(`show ${head}`);
        expect(show).toContain('second');
    });

    it('consolidates a prior pack into the new one and removes the old .pack/.idx', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m first');
        const firstGc = await mg.gc();
        const firstPack = firstGc.packFilename;

        await mg.writeFile('b.txt', '2');
        await mg.exec('add .');
        await mg.exec('commit -m second');

        const secondGc = await mg.gc();
        expect(secondGc.packsRemoved).toBe(1);
        const packs = listPacks(mg);
        expect(packs).toEqual([secondGc.packFilename]);
        expect(packs).not.toContain(firstPack);

        // .idx for the old pack is gone too
        const packDir = mg.fs.readdirSync(`${mg.dir}/.git/objects/pack`) as string[];
        expect(packDir.some(n => n.startsWith(firstPack.replace(/\.pack$/, '')))).toBe(false);
    });

    it('with consolidatePacks:false leaves prior packs in place', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m first');
        const first = await mg.gc();

        await mg.writeFile('b.txt', '2');
        await mg.exec('add .');
        await mg.exec('commit -m second');

        const second = await mg.gc({ consolidatePacks: false });
        expect(second.packsRemoved).toBe(0);
        const packs = listPacks(mg);
        expect(packs).toContain(first.packFilename);
        expect(packs).toContain(second.packFilename);
    });

    it('prunes objects orphaned by reset --hard (no reflog grace period)', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m first');
        const firstHead = await mg.resolveRef('HEAD');

        await mg.writeFile('a.txt', '2');
        await mg.exec('add .');
        await mg.exec('commit -m second');
        const orphanedHead = await mg.resolveRef('HEAD');
        expect(orphanedHead).not.toBe(firstHead);

        await mg.exec(`reset --hard ${firstHead}`);
        await mg.gc();

        // The orphaned commit must not be readable any more.
        await expect(mg.exec(`show ${orphanedHead}`)).rejects.toThrow();
    });

    it('is exposed via the exec dispatcher as `git gc`', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m first');

        const out = await mg.exec('gc');
        expect(out).toMatch(/Counting objects/);
        expect(countLoose(mg)).toBe(0);

        const quiet = await mg.exec('gc --quiet');
        expect(quiet).toBe('');
    });

    it('throws EROFS on a read-only view', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m first');

        const view = mg.readOnlyView();
        await expect(view.gc()).rejects.toThrow(/EROFS/);
    });

    it('produces a disk repo that native git can read after flush({clean:true})', async () => {
        const tmp = await fsRealAsync.mkdtemp(path.join(os.tmpdir(), 'mg-gc-'));
        try {
            await sh(tmp, 'init', '-b', 'main');
            await fsRealAsync.writeFile(path.join(tmp, 'a.txt'), 'one');
            await sh(tmp, 'add', '.');
            await sh(tmp, 'commit', '-m', 'first');

            const local = new MemoryGit('gc-flush');
            await local.loadFromDisk(tmp);
            local.setAuthor('Test', 't@t');

            for (let i = 0; i < 3; i++) {
                await local.writeFile(`f${i}.txt`, `c${i}`);
                await local.exec('add .');
                await local.exec(`commit -m c${i}`);
            }

            await local.gc();
            await local.flush(null, { clean: true });

            // Native git fsck must agree the on-disk repo is intact.
            await sh(tmp, 'fsck', '--full');

            // And the loose object dir on disk is empty.
            const objectsDir = path.join(tmp, '.git', 'objects');
            const entries = await fsRealAsync.readdir(objectsDir);
            for (const name of entries) {
                if (!/^[0-9a-f]{2}$/.test(name)) continue;
                const sub = await fsRealAsync.readdir(path.join(objectsDir, name));
                expect(sub).toEqual([]);
            }
        } finally {
            await fsRealAsync.rm(tmp, { recursive: true, force: true });
        }
    });
});
