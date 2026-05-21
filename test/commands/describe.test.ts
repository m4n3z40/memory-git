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

    it('rejects describe without both --exact-match and --tags', async () => {
        await expect(mg.exec('describe HEAD')).rejects.toThrow(/only `describe --exact-match --tags/);
    });
});
