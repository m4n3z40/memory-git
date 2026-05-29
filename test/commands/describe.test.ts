import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryGit } from '../../src/index';

describe('exec("describe")', () => {
    let mg: MemoryGit;

    beforeEach(async () => {
        mg = new MemoryGit('describe-test');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');
    });

    it('returns the tag name when --exact-match --tags matches a tagged commit', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');
        await mg.exec('tag v1.0');
        const head = await mg.resolveRef('HEAD');

        const out = await mg.exec(`describe --exact-match --tags ${head}`);
        expect(out).toBe('v1.0');
    });

    it('throws "no tag exactly matches" when the commit has no tag', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');
        const head = await mg.resolveRef('HEAD');

        await expect(mg.exec(`describe --exact-match --tags ${head}`))
            .rejects.toThrow(`fatal: no tag exactly matches '${head}'`);
    });

    it('throws a meaningful error for a non-existent ref', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');

        await expect(mg.exec('describe --exact-match --tags deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'))
            .rejects.toThrow();
    });

    it('default form: <tag>-<N>-g<short> when ref is N commits past a tag', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');
        await mg.exec('tag -a v1.0 -m anno'); // annotated → eligible by default
        await mg.writeFile('a.txt', '2');
        await mg.exec('add .');
        await mg.exec('commit -m next');
        const head = await mg.resolveRef('HEAD');

        const out = await mg.exec('describe HEAD');
        expect(out).toBe(`v1.0-1-g${head.slice(0, 7)}`);
    });

    it('default form: just <tag> when ref IS the tagged commit', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');
        await mg.exec('tag -a v1.0 -m anno');

        expect(await mg.exec('describe HEAD')).toBe('v1.0');
    });

    it('default form skips lightweight tags; --tags includes them', async () => {
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');
        await mg.exec('tag v-light'); // lightweight
        await mg.writeFile('a.txt', '2');
        await mg.exec('add .');
        await mg.exec('commit -m next');

        // Default: no annotated tag in history → error.
        await expect(mg.exec('describe HEAD')).rejects.toThrow(/No names found/);
        // --tags: lightweight is eligible → describe succeeds.
        expect(await mg.exec('describe --tags HEAD')).toMatch(/^v-light-1-g[0-9a-f]{7}$/);
    });
});
