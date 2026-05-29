import { describe, it, expect } from 'vitest';
import { MemoryGit } from '../src/index';

/**
 * OID-level reproducibility: with pinned `{author, committer, date}` (and tz),
 * memory-git produces the same SHA-1 commit/merge/tag-object OID as native
 * `git` would on identical input. Without this, a repo created in memory-git
 * is NOT interoperable with the same logical state created via git CLI —
 * blocks pods-manager's load → mutate → flush → external-git workflows.
 *
 * Pinned OIDs come from `git` 2.x (cat-file -p of the equivalent objects)
 * with `GIT_AUTHOR_DATE='1700000000 +0000'` / `GIT_COMMITTER_DATE` matching.
 * If these break under an iso-git upgrade, the hash output of writeCommit
 * changed — re-derive against the reference `git` build and update.
 */

const TS = 1700000000;
const ME = { name: 'T', email: 't@t', timestamp: TS, timezoneOffset: 0 } as const;

async function seed(name: string): Promise<MemoryGit> {
    const mg = new MemoryGit(name);
    mg.setAuthor('T', 't@t');
    await mg.init();
    return mg;
}

describe('OID-level parity vs native git', () => {
    it('linear commit hashes to the same OID as `git commit` under fixed date', async () => {
        const mg = await seed('lin');
        await mg.writeFile('a.txt', 'hello\n');
        await mg.add('.');
        const oid = await mg.commit('msg', { author: { ...ME }, committer: { ...ME } });
        // Verified against `git commit -m msg` with GIT_*_DATE='1700000000 +0000'.
        expect(oid).toBe('6a30592fffa317297155338f90ca54c11332adaf');
    });

    it('merge commit hashes to the same OID as `git merge --no-ff` under fixed date', async () => {
        const mg = await seed('merge');
        const A = { author: { ...ME }, committer: { ...ME } };
        await mg.writeFile('r.txt', 'r\n'); await mg.add('.'); await mg.commit('r', A);
        await mg.exec('branch side');
        await mg.exec('checkout side');
        await mg.writeFile('s.txt', 's\n'); await mg.add('.'); await mg.commit('s', A);
        await mg.exec('checkout main');
        await mg.writeFile('m.txt', 'm\n'); await mg.add('.'); await mg.commit('m', A);
        const res = await mg.merge('side', { noFastForward: true, message: 'merge', ...A });
        // Verified against `git merge --no-ff -m merge side` on the equivalent
        // disk repo with GIT_*_DATE='1700000000 +0000'.
        expect(res.oid).toBe('544ac7450d240ac17ac252dd6c2d5b563d453acd');
    });

    it('annotated tag hashes to the same tag-object OID as `git tag -a` under fixed date', async () => {
        const mg = await seed('tag');
        await mg.writeFile('a.txt', 'A\n');
        await mg.add('.');
        await mg.commit('c', { author: { ...ME }, committer: { ...ME } });

        await mg.createTag('v1', {
            ref: 'HEAD', annotated: true, message: 'anno',
            tagger: { name: 'T', email: 't@t', timezoneOffset: 0 },
            date: TS * 1000,
        });
        const refs = await mg.showTagRefs();
        const v1 = refs.find(r => r.tagName === 'v1')!;
        // Verified against `git tag -a v1 -m anno` with the same env.
        expect(v1.refOid).toBe('bff3112c02fca1b84c43ca39727b4f5d3c6dfc65');
        // Peeled commit (the commit the tag points at) also stable.
        expect(v1.commitOid).toBe('91abf60d9c3c8a33da4d99b77872b46f3f1c662a');
    });

    it('merge: same inputs → same OID across two independent instances (determinism)', async () => {
        // Cross-check: even if a future iso-git upgrade changes the canonical
        // hash, two runs with identical inputs must still agree. This catches
        // any accidental Date.now()/local-TZ leakage in the merge path.
        const build = async (name: string) => {
            const mg = await seed(name);
            const A = { author: { ...ME }, committer: { ...ME } };
            await mg.writeFile('r.txt', 'r\n'); await mg.add('.'); await mg.commit('r', A);
            await mg.exec('branch side');
            await mg.exec('checkout side');
            await mg.writeFile('s.txt', 's\n'); await mg.add('.'); await mg.commit('s', A);
            await mg.exec('checkout main');
            await mg.writeFile('m.txt', 'm\n'); await mg.add('.'); await mg.commit('m', A);
            return (await mg.merge('side', { noFastForward: true, message: 'merge', ...A })).oid;
        };
        const a = await build('det-a');
        const b = await build('det-b');
        expect(a).toBe(b);
    });

    it('annotated tag honors explicit timezoneOffset over date-derived local tz', async () => {
        // When user passes `date` but no tagger.timezoneOffset, the helper
        // falls back to local tz. When user passes timezoneOffset:0, the tag
        // object must serialize "+0000" regardless of where the test runs.
        const mg = await seed('tz');
        await mg.writeFile('a.txt', 'A\n');
        await mg.add('.');
        await mg.commit('c', { author: { ...ME }, committer: { ...ME } });

        await mg.createTag('v1', {
            ref: 'HEAD', annotated: true, message: 'anno',
            tagger: { name: 'T', email: 't@t', timezoneOffset: 0 },
            date: TS * 1000,
        });
        const refs = await mg.showTagRefs();
        // If the helper had clobbered tz with local, refOid would differ.
        // The pinned UTC value confirms tz=0 was honored.
        expect(refs.find(r => r.tagName === 'v1')!.refOid)
            .toBe('bff3112c02fca1b84c43ca39727b4f5d3c6dfc65');
    });
});
