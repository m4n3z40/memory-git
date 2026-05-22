import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryGit } from '../../src/index';

async function buildLinearHistory(name: string): Promise<{ mg: MemoryGit; oids: string[] }> {
    const mg = new MemoryGit(name);
    await mg.init();
    mg.setAuthor('Test', 't@t.com');
    const oids: string[] = [];
    for (const m of ['c1', 'c2', 'c3', 'c4']) {
        await mg.writeFile(`${m}.txt`, m);
        await mg.exec('add .');
        await mg.exec(`commit -m ${m}`);
        oids.push(await mg.resolveRef('HEAD'));
    }
    return { mg, oids };
}

async function buildMergeHistory(name: string): Promise<MemoryGit> {
    const mg = new MemoryGit(name);
    await mg.init();
    mg.setAuthor('Test', 't@t.com');
    await mg.writeFile('base.txt', 'base');
    await mg.exec('add .');
    await mg.exec('commit -m base');
    await mg.exec('branch feature');
    await mg.writeFile('main.txt', 'main');
    await mg.exec('add .');
    await mg.exec('commit -m main');
    await mg.exec('checkout feature');
    await mg.writeFile('feature.txt', 'feat');
    await mg.exec('add .');
    await mg.exec('commit -m feat');
    await mg.exec('checkout main');
    await mg.merge('feature', { noFastForward: true, message: 'merge feat\n' });
    return mg;
}

describe('rev suffix syntax (~, ~N, ^, ^N)', () => {
    describe('typed API via resolveRef', () => {
        let mg: MemoryGit;
        let oids: string[];

        beforeEach(async () => {
            ({ mg, oids } = await buildLinearHistory('rev-suffix-typed'));
        });

        it('resolves HEAD~ (bare) to HEAD~1', async () => {
            expect(await mg.resolveRef('HEAD~')).toBe(oids[2]);
        });

        it('resolves HEAD~N for N within history', async () => {
            expect(await mg.resolveRef('HEAD~1')).toBe(oids[2]);
            expect(await mg.resolveRef('HEAD~2')).toBe(oids[1]);
            expect(await mg.resolveRef('HEAD~3')).toBe(oids[0]);
        });

        it('resolves HEAD^ as HEAD^1', async () => {
            expect(await mg.resolveRef('HEAD^')).toBe(oids[2]);
        });

        it('resolves chained suffixes (HEAD~2^)', async () => {
            // HEAD~2 = oids[1], ^ = its first parent = oids[0]
            expect(await mg.resolveRef('HEAD~2^')).toBe(oids[0]);
        });

        it('works on branch names too (main~1)', async () => {
            expect(await mg.resolveRef('main~1')).toBe(oids[2]);
        });

        it('^0 resolves to the commit itself', async () => {
            expect(await mg.resolveRef('HEAD^0')).toBe(oids[3]);
        });

        it('throws when walking past the root commit', async () => {
            await expect(mg.resolveRef('HEAD~99')).rejects.toThrow(/walked past root|unknown revision/i);
        });

        it('throws on bare suffix (~1 with no base)', async () => {
            await expect(mg.resolveRef('~1')).rejects.toThrow(/bad revision/i);
        });
    });

    describe('exec dispatch', () => {
        it('show HEAD~1 returns the parent commit', async () => {
            const { mg, oids } = await buildLinearHistory('rev-suffix-show');
            const out = await mg.exec('show HEAD~1');
            expect(out).toContain(oids[2]);
        });

        it('rev-parse HEAD~ matches HEAD~1', async () => {
            const { mg } = await buildLinearHistory('rev-suffix-revparse');
            const a = await mg.exec('rev-parse HEAD~');
            const b = await mg.exec('rev-parse HEAD~1');
            expect(a).toBe(b);
        });

        it('rev-list HEAD~1 walks from the parent', async () => {
            const { mg, oids } = await buildLinearHistory('rev-suffix-revlist');
            const out = await mg.exec('rev-list HEAD~1');
            expect(out.split('\n')).toEqual([oids[2], oids[1], oids[0]]);
        });

        it('log HEAD~2 starts from the grandparent', async () => {
            const { mg } = await buildLinearHistory('rev-suffix-log');
            const out = await mg.exec('log HEAD~2 --oneline');
            // 3 commits from HEAD~2 down to root: c2, c1
            // (HEAD~2 itself = c2, so we expect 2 lines: c2 and c1)
            const lines = out.split('\n').filter(Boolean);
            expect(lines.length).toBe(2);
            expect(lines[0]).toMatch(/c2/);
            expect(lines[1]).toMatch(/c1/);
        });

        it('diff --name-only HEAD~1 HEAD shows the last commit file', async () => {
            const { mg } = await buildLinearHistory('rev-suffix-diff');
            const out = await mg.exec('diff --name-only HEAD~1 HEAD');
            expect(out).toBe('c4.txt');
        });

        it('diff --diff-filter=A HEAD~3 HEAD lists the three added files', async () => {
            const { mg } = await buildLinearHistory('rev-suffix-diff-filter');
            const out = await mg.exec('diff --name-only --diff-filter=A HEAD~3 HEAD');
            expect(out.split('\n').sort()).toEqual(['c2.txt', 'c3.txt', 'c4.txt']);
        });
    });

    describe('merge-commit ^N semantics', () => {
        it('^1 is the first parent (the line being merged INTO)', async () => {
            const mg = await buildMergeHistory('rev-suffix-merge-first');
            const mergeOid = await mg.resolveRef('HEAD');
            const firstParent = await mg.resolveRef('HEAD^1');
            // First parent should be the tip of main pre-merge — has main.txt, not feature.txt
            const mainTip = await mg.readFileAtRef('main.txt', firstParent) as string;
            expect(mainTip).toBe('main');
            expect(firstParent).not.toBe(mergeOid);
        });

        it('^2 is the second parent (the branch being merged IN)', async () => {
            const mg = await buildMergeHistory('rev-suffix-merge-second');
            const secondParent = await mg.resolveRef('HEAD^2');
            // Second parent should be the tip of feature — has feature.txt, not main.txt
            const featTip = await mg.readFileAtRef('feature.txt', secondParent) as string;
            expect(featTip).toBe('feat');
        });

        it('throws when asking for ^N beyond the parent count', async () => {
            const mg = await buildMergeHistory('rev-suffix-merge-no-third');
            await expect(mg.resolveRef('HEAD^3')).rejects.toThrow(/no parent 3|unknown revision/i);
        });
    });
});
