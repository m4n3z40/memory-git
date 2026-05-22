import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryGit } from '../../src/index';

describe('exec("branch")', () => {
    let mg: MemoryGit;

    beforeEach(async () => {
        mg = new MemoryGit('branch-test');
        await mg.init();
        mg.setAuthor('Test', 'test@test.com');
        await mg.writeFile('a.txt', '1');
        await mg.exec('add .');
        await mg.exec('commit -m init');
    });

    describe('--show-current', () => {
        it('prints the current branch name', async () => {
            const out = await mg.exec('branch --show-current');
            expect(out).toBe(await mg.currentBranch());
            expect(out.length).toBeGreaterThan(0);
        });

        it('reflects the active branch after checkout', async () => {
            await mg.exec('branch feature-x');
            await mg.exec('checkout feature-x');
            const out = await mg.exec('branch --show-current');
            expect(out).toBe('feature-x');
        });

        it('returns empty string when HEAD is detached', async () => {
            const head = await mg.resolveRef('HEAD');
            await mg.exec(`checkout ${head}`);
            const out = await mg.exec('branch --show-current');
            expect(out).toBe('');
        });
    });
});
