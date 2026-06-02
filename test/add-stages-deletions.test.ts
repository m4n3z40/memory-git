import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { MemoryGit } from '../src/index';

/**
 * Regression: `git add .` / `git add -A` (and native `add('.')`) must stage
 * working-tree deletions, like real git (>=2.0) — including after a
 * flush + loadFromDisk round-trip, which used to leave a pending deletion
 * un-stageable via `add` (only `git rm`/`remove()` worked) while `status`
 * still reported "D", so add/commit disagreed ("nothing to commit").
 */
describe('add stages working-tree deletions', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mg-del-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    async function base(lazy: boolean): Promise<MemoryGit> {
        const mg = new MemoryGit('r', { lazy });
        mg.setAuthor('t', 't@t.com');
        await mg.init();
        await mg.writeFile('a.txt', 'x');
        await mg.add('.');
        await mg.commit('base');
        await mg.flush(dir);
        return mg;
    }

    const inHead = async (mg: MemoryGit) =>
        (await mg.listTrackedFiles()).includes('a.txt');

    for (const lazy of [false, true]) {
        describe(`lazy=${lazy}`, () => {
            it("exec('git add .') stages a deletion (no loadFromDisk)", async () => {
                const mg = await base(lazy);
                await mg.deleteFile('a.txt');
                await mg.flush(dir);
                await mg.exec('git add .');
                await mg.commit('del');
                expect(await inHead(mg)).toBe(false);
            });

            it("exec('git add -A') stages a deletion (no loadFromDisk)", async () => {
                const mg = await base(lazy);
                await mg.deleteFile('a.txt');
                await mg.flush(dir);
                await mg.exec('git add -A');
                await mg.commit('del');
                expect(await inHead(mg)).toBe(false);
            });

            it("native add('.') stages a deletion (no loadFromDisk)", async () => {
                const mg = await base(lazy);
                await mg.deleteFile('a.txt');
                await mg.flush(dir);
                await mg.add('.');
                await mg.commit('del');
                expect(await inHead(mg)).toBe(false);
            });

            it("exec('git add -A') stages a pending deletion after loadFromDisk", async () => {
                const mg = await base(lazy);
                await mg.deleteFile('a.txt');
                await mg.flush(dir);
                await mg.loadFromDisk(dir, { respectGitignore: true });
                await mg.exec('git add -A');
                await mg.commit('del');
                expect(await inHead(mg)).toBe(false);
            });

            it("native add('.') stages a pending deletion after loadFromDisk", async () => {
                const mg = await base(lazy);
                await mg.deleteFile('a.txt');
                await mg.flush(dir);
                await mg.loadFromDisk(dir, { respectGitignore: true });
                await mg.add('.');
                await mg.commit('del');
                expect(await inHead(mg)).toBe(false);
            });

            it('status and commit agree after staging a deletion (loadFromDisk)', async () => {
                const mg = await base(lazy);
                await mg.deleteFile('a.txt');
                await mg.flush(dir);
                await mg.loadFromDisk(dir, { respectGitignore: true });
                await mg.exec('git add -A');
                // Once staged, status reports a staged deletion ("D " in the
                // first column), not an unstaged one (" D"), and commit must
                // not claim "nothing to commit".
                const status = await mg.exec('git status --porcelain');
                expect(status.trim()).toBe('D  a.txt');
                await expect(mg.commit('del')).resolves.toBeTruthy();
                expect(await inHead(mg)).toBe(false);
            });
        });
    }
});
