import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryGit } from '../src/index';

/**
 * Coverage for the recent parity-sweep wins:
 *  - log/show emit `Merge: <p1> <p2>` between the commit line and Author:
 *    for merge commits (matches `git log`/`git show` byte-for-byte).
 *  - log `--format=<fmt>` expands the common placeholders.
 *  - default date format matches git's `Thu Jan 1 00:00:00 2026 +0000` shape,
 *    using the commit's own tz offset (not the local machine's).
 *  - show suppresses the change-list section on merge commits (matches
 *    `git show` default).
 */

const ME = { name: 'T', email: 't@t', timestamp: 1700000000, timezoneOffset: 0 } as const;

async function seed(name: string): Promise<MemoryGit> {
    const mg = new MemoryGit(name);
    mg.setAuthor('T', 't@t');
    await mg.init();
    return mg;
}

describe('log/show parity', () => {
    let mg: MemoryGit;
    let nonce = 0;
    beforeEach(async () => { mg = await seed(`lg-${++nonce}`); });

    it('default date format matches git: `Thu Jan 1 00:00:00 2026 +0000` style', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.add('.');
        // Use a date with a recognizable wall-clock value at UTC.
        await mg.commit('msg', {
            author: { ...ME, timestamp: 1735689600, timezoneOffset: 0 }, // 2025-01-01T00:00:00Z
            committer: { ...ME, timestamp: 1735689600, timezoneOffset: 0 },
        });
        const out = await mg.exec('log -n 1');
        expect(out).toContain('Date:   Wed Jan 1 00:00:00 2025 +0000');
    });

    it('date format honors the commit\'s own tz offset, not the local TZ', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.add('.');
        // tz = -300 = UTC+5 (e.g., Asia/Karachi). With tz applied, wall-clock
        // is 05:00 instead of 00:00 UTC. The minus-sign convention is git's:
        // 'minutes west of UTC' positive in JS → negative '+HHMM' direction.
        await mg.commit('msg', {
            author: { ...ME, timestamp: 1735689600, timezoneOffset: -300 },
            committer: { ...ME, timestamp: 1735689600, timezoneOffset: -300 },
        });
        const out = await mg.exec('log -n 1');
        expect(out).toContain('Date:   Wed Jan 1 05:00:00 2025 +0500');
    });

    it('emits Merge: <p1> <p2> for merge commits in log and show', async () => {
        const A = { author: { ...ME }, committer: { ...ME } };
        await mg.writeFile('r.txt', 'r'); await mg.add('.'); await mg.commit('r', A);
        await mg.exec('branch side');
        await mg.writeFile('m.txt', 'm'); await mg.add('.'); const main = await mg.commit('m', A);
        await mg.exec('checkout side');
        await mg.writeFile('s.txt', 's'); await mg.add('.'); const side = await mg.commit('s', A);
        await mg.exec('checkout main');
        const res = await mg.merge('side', { noFastForward: true, message: 'merge', ...A });
        const merge = res.oid!;

        const logOut = await mg.exec('log -n 1');
        expect(logOut).toContain(`commit ${merge}`);
        expect(logOut).toContain(`Merge: ${main.slice(0, 7)} ${side.slice(0, 7)}`);
        expect(logOut.indexOf('Merge:')).toBeLessThan(logOut.indexOf('Author:'));

        const showOut = await mg.exec('show HEAD');
        expect(showOut).toContain(`Merge: ${main.slice(0, 7)} ${side.slice(0, 7)}`);
        // Native `git show` on a merge emits no per-parent diff by default;
        // we follow suit and skip the change-list section.
        expect(showOut).not.toMatch(/^[ACDM]\t/m);
    });

    it('log --format=%H emits one full hash per commit', async () => {
        const A = { author: { ...ME }, committer: { ...ME } };
        await mg.writeFile('a', '1'); await mg.add('.'); const c1 = await mg.commit('c1', A);
        await mg.writeFile('a', '2'); await mg.add('.'); const c2 = await mg.commit('c2', A);
        const out = await mg.exec('log --format=%H');
        const lines = out.split('\n').filter(Boolean);
        expect(lines).toEqual([c2, c1]);
    });

    it('log --format=%h\\ %s formats short-hash + subject', async () => {
        const A = { author: { ...ME }, committer: { ...ME } };
        await mg.writeFile('a', '1'); await mg.add('.'); const c1 = await mg.commit('hello world', A);
        const out = await mg.exec('log --format=%h\\ %s');
        expect(out).toBe(`${c1.slice(0, 7)} hello world`);
    });

    it('log --format=%an,%ae,%at,%T resolves author/timestamp/tree', async () => {
        // Comma is shell-safe (not a metacharacter). `|`, `<`, `>` would be
        // parsed by the exec dispatcher's shell-quote layer. The format
        // expander itself handles any character; only the shell tokenizer cares.
        const A = { author: { ...ME }, committer: { ...ME } };
        await mg.writeFile('a', '1'); await mg.add('.'); const c1 = await mg.commit('c', A);
        const out = await mg.exec('log --format=%an,%ae,%at,%T');
        const treeFromShow = (await mg.show('HEAD')).commit.tree!;
        expect(out).toBe(`T,t@t,${ME.timestamp},${treeFromShow}`);
        expect(c1).toMatch(/^[0-9a-f]{40}$/);
    });

    it('log --format expands %n (newline) and %% (literal %) — via logText direct call', async () => {
        // exec("log --format=...") goes through shell-quote tokenization which
        // can mangle special characters like `%`. The programmatic API has no
        // such layer, so we exercise expansion via mg.logText directly.
        const A = { author: { ...ME }, committer: { ...ME } };
        await mg.writeFile('a', '1'); await mg.add('.'); await mg.commit('c', A);
        const head = await mg.resolveRef('HEAD');
        const out = await mg.logText({ format: 'x%%y%n--%h--' });
        expect(out).toBe(`x%y\n--${head.slice(0, 7)}--`);
    });
});

describe('showRefs parity', () => {
    it('default lists heads + tags (no remotes set in repo)', async () => {
        const mg = await seed('sr');
        await mg.writeFile('a', '1'); await mg.add('.'); await mg.commit('c');
        await mg.exec('tag v1');
        const head = await mg.resolveRef('HEAD');

        const refs = await mg.showRefs();
        const lines = refs.map(r => `${r.oid} ${r.ref}`);
        expect(lines).toContain(`${head} refs/heads/main`);
        expect(lines).toContain(`${head} refs/tags/v1`);
    });

    it('annotated tag carries `peeled`; lightweight tag does not', async () => {
        const mg = await seed('peel');
        await mg.writeFile('a', '1'); await mg.add('.'); await mg.commit('c');
        await mg.exec('tag v-light');
        await mg.exec('tag -a v-anno -m anno');

        const refs = await mg.showRefs({ tags: true });
        const anno = refs.find(r => r.ref === 'refs/tags/v-anno')!;
        const light = refs.find(r => r.ref === 'refs/tags/v-light')!;
        expect(anno.peeled).toBeDefined();
        expect(anno.peeled).not.toBe(anno.oid);
        expect(light.peeled).toBeUndefined();
    });
});
