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

    it('prints "<commitOid> refs/tags/<name>" for lightweight and annotated tags', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');
        const head = await mg.resolveRef('HEAD');

        await mg.exec('tag v-light');
        await mg.exec('tag -a v-anno -m "annotated release"');

        const out = await mg.exec('show-ref --tags -d');
        const lines = out.split('\n').sort();

        // showTagRefs() dereferences annotated tags to their commit, and does not
        // distinguish annotated vs lightweight — so only the single line per tag
        // is emitted (no `^{}` peel suffix).
        expect(lines).toEqual([
            `${head} refs/tags/v-anno`,
            `${head} refs/tags/v-light`,
        ]);
    });

    it('rejects show-ref without --tags', async () => {
        await expect(mg.exec('show-ref')).rejects.toThrow(/only `show-ref --tags`/);
    });
});
