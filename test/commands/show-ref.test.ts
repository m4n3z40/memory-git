import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryGit } from '../../src/index';

describe('exec("show-ref")', () => {
    let mg: MemoryGit;

    beforeEach(async () => {
        mg = new MemoryGit('show-ref-test');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');
    });

    it('returns empty string when there are no tags (git would exit 1)', async () => {
        // memory-git surfaces no-match as empty stdout; git CLI would exit 1.
        const out = await mg.exec('show-ref --tags -d');
        expect(out).toBe('');
    });

    it('emits the ref-pointed OID per tag (tag-object for annotated, commit for lightweight)', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');
        const head = await mg.resolveRef('HEAD');

        await mg.exec('tag v-light');
        await mg.exec('tag -a v-anno -m "annotated release"');

        // Public API exposes both OIDs: refOid (what `show-ref` emits) and
        // commitOid (the peeled commit). Annotated → refOid is the tag
        // object's own OID, distinct from the commit. Lightweight → they match.
        const refs = await mg.showTagRefs();
        const anno = refs.find(r => r.tagName === 'v-anno')!;
        const light = refs.find(r => r.tagName === 'v-light')!;
        expect(anno.commitOid).toBe(head);
        expect(anno.refOid).not.toBe(head);
        expect(anno.refOid).toMatch(/^[0-9a-f]{40}$/);
        expect(light.refOid).toBe(head);
        expect(light.commitOid).toBe(head);

        // Default: one line per tag, refOid first column (matches `git show-ref --tags`).
        const plain = (await mg.exec('show-ref --tags')).split('\n');
        expect(new Set(plain)).toEqual(new Set([
            `${anno.refOid} refs/tags/v-anno`,
            `${head} refs/tags/v-light`,
        ]));

        // `-d`: annotated gets an extra `^{}` line with the peeled commit
        // (matches `git show-ref --tags -d`); lightweight stays single-line
        // (no peel — refOid IS the commit).
        const deref = await mg.exec('show-ref --tags -d');
        const lines = deref.split('\n');
        expect(lines).toContain(`${anno.refOid} refs/tags/v-anno`);
        expect(lines).toContain(`${head} refs/tags/v-anno^{}`);
        expect(lines).toContain(`${head} refs/tags/v-light`);
        expect(lines).not.toContain(`${head} refs/tags/v-light^{}`);
        expect(lines).toHaveLength(3); // 2 lines for annotated, 1 for lightweight
    });

    it('show-ref without flags lists heads + tags (default = everything, matches git)', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');
        const head = await mg.resolveRef('HEAD');
        await mg.exec('tag v1');

        const out = await mg.exec('show-ref');
        const lines = out.split('\n');
        expect(lines).toContain(`${head} refs/heads/main`);
        expect(lines).toContain(`${head} refs/tags/v1`);
    });

    it('show-ref --heads emits only refs/heads/*', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');
        const head = await mg.resolveRef('HEAD');
        await mg.exec('tag v1');

        const out = await mg.exec('show-ref --heads');
        const lines = out.split('\n');
        expect(lines).toEqual([`${head} refs/heads/main`]);
        expect(lines.every(l => !l.includes('refs/tags/'))).toBe(true);
    });
});
