import { describe, it, expect } from 'vitest';
import { MemoryGit } from '../src/index';

/**
 * Pin the unified-diff and --stat output shapes against `git diff` byte-for-
 * byte (mode 100644, text content). Hunks are generated via jsdiff's
 * structuredPatch, so this is also a regression guard for the jsdiff version
 * pin.
 */

const ME = { name: 'T', email: 't@t', timestamp: 1700000000, timezoneOffset: 0 } as const;
const A = { author: { ...ME }, committer: { ...ME } } as const;

async function seed(name: string): Promise<MemoryGit> {
    const mg = new MemoryGit(name);
    mg.setAuthor('T', 't@t');
    await mg.init();
    return mg;
}

describe('diff: unified format', () => {
    it("emits `diff --git a/X b/X` + index + --- / +++ + @@ hunk for a modification", async () => {
        const mg = await seed('uni-1');
        await mg.writeFile('a.txt', 'one\ntwo\nthree\n');
        await mg.add('.'); const c1 = await mg.commit('c1', A);
        await mg.writeFile('a.txt', 'one\nTWO\nthree\n');
        await mg.add('.'); await mg.commit('c2', A);

        const out = await mg.exec(`diff ${c1} HEAD`);
        expect(out).toContain('diff --git a/a.txt b/a.txt');
        expect(out).toMatch(/index [0-9a-f]{7}\.\.[0-9a-f]{7} 100644/);
        expect(out).toContain('--- a/a.txt');
        expect(out).toContain('+++ b/a.txt');
        expect(out).toContain('@@ -1,3 +1,3 @@');
        expect(out).toContain('-two');
        expect(out).toContain('+TWO');
        expect(out.endsWith('\n')).toBe(true); // native git terminates with \n
    });

    it("emits `new file mode 100644` + zero-OID index for an added file", async () => {
        const mg = await seed('uni-add');
        await mg.writeFile('a.txt', '1\n');
        await mg.add('.'); const c1 = await mg.commit('c1', A);
        await mg.writeFile('new.txt', 'fresh\n');
        await mg.add('.'); await mg.commit('c2', A);

        const out = await mg.exec(`diff ${c1} HEAD`);
        expect(out).toContain('diff --git a/new.txt b/new.txt');
        expect(out).toContain('new file mode 100644');
        // Native git uses 7-char OIDs; old side is 0000000 for a new file.
        expect(out).toMatch(/index 0000000\.\.[0-9a-f]{7}\b/);
        expect(out).toContain('--- /dev/null');
        expect(out).toContain('+++ b/new.txt');
        // Hunk header for "no lines on the old side": start=0, count=0.
        expect(out).toContain('@@ -0,0 +1 @@'); // git compacts ,1 to nothing
        expect(out).toContain('+fresh');
    });

    it("emits `deleted file mode 100644` + zero-OID index for a deletion (hunk uses start=0 when newLines=0)", async () => {
        const mg = await seed('uni-del');
        await mg.writeFile('a.txt', '1\n');
        await mg.writeFile('gone.txt', 'bye\nworld\n');
        await mg.add('.'); const c1 = await mg.commit('c1', A);
        await mg.deleteFile('gone.txt');
        await mg.add('.'); await mg.commit('c2', A);

        const out = await mg.exec(`diff ${c1} HEAD`);
        expect(out).toContain('diff --git a/gone.txt b/gone.txt');
        expect(out).toContain('deleted file mode 100644');
        expect(out).toMatch(/index [0-9a-f]{7}\.\.0000000\b/);
        expect(out).toContain('--- a/gone.txt');
        expect(out).toContain('+++ /dev/null');
        // Crucial: native git uses start=0 (not 1) when the side has no lines.
        expect(out).toContain('@@ -1,2 +0,0 @@');
        expect(out).toContain('-bye');
        expect(out).toContain('-world');
    });

    it('binary file (NUL byte) → emits `Binary files differ`, no hunks', async () => {
        const mg = await seed('uni-bin');
        await mg.writeFile('blob.bin', 'abc\x00def');
        await mg.add('.'); const c1 = await mg.commit('c1', A);
        await mg.writeFile('blob.bin', 'xyz\x00ghi');
        await mg.add('.'); await mg.commit('c2', A);

        const out = await mg.exec(`diff ${c1} HEAD`);
        expect(out).toContain('Binary files a/blob.bin and b/blob.bin differ');
        expect(out).not.toContain('@@'); // no hunks on binary
    });
});

describe('diff --stat', () => {
    it('emits per-file row + summary with insertions/deletions', async () => {
        const mg = await seed('stat-1');
        await mg.writeFile('a.txt', '1\n2\n3\n');
        await mg.writeFile('b.txt', 'x\n');
        await mg.add('.'); const c1 = await mg.commit('c1', A);

        await mg.writeFile('a.txt', '1\n2\n3\n4\n5\n');     // +2
        await mg.writeFile('b.txt', '');                     // -1
        await mg.add('.'); await mg.commit('c2', A);

        const out = await mg.exec(`diff --stat ${c1} HEAD`);
        const lines = out.split('\n');
        // Per-file lines: ` <name> | <count> <bar>`
        expect(lines.some(l => /^\s+a\.txt\s+\|\s+2\s+\++/.test(l))).toBe(true);
        expect(lines.some(l => /^\s+b\.txt\s+\|\s+1\s+-/.test(l))).toBe(true);
        // Summary: `<N> files changed, <X> insertions(+), <Y> deletions(-)`
        expect(out).toMatch(/2 files changed, 2 insertions\(\+\), 1 deletion\(-\)/);
    });

    it('singular nouns when counts are 1 (matches git)', async () => {
        const mg = await seed('stat-sing');
        await mg.writeFile('a.txt', '');
        await mg.add('.'); const c1 = await mg.commit('c1', A);
        await mg.writeFile('a.txt', 'one\n');
        await mg.add('.'); await mg.commit('c2', A);

        const out = await mg.exec(`diff --stat ${c1} HEAD`);
        expect(out).toMatch(/1 file changed, 1 insertion\(\+\)/);
    });
});

describe('describe: N matches git in merge DAGs', () => {
    it('linear: N = commits since tag (rev-list count)', async () => {
        const mg = await seed('desc-lin');
        await mg.writeFile('a', '1'); await mg.add('.'); await mg.commit('c1', A);
        await mg.exec('tag -a v1 -m anno');
        await mg.writeFile('a', '2'); await mg.add('.'); await mg.commit('c2', A);
        await mg.writeFile('a', '3'); await mg.add('.'); await mg.commit('c3', A);
        const head = await mg.resolveRef('HEAD');

        // Two commits past v1 (annotated). Linear → N = 2.
        expect(await mg.exec('describe HEAD')).toBe(`v1-2-g${head.slice(0, 7)}`);
    });

    it('merge: N = (visited-1) + extra-parents (matches git, not rev-list count)', async () => {
        // c1 → c2 (v1 ann) → c3 → merge
        //              └── s1 → s2 (intentional — tag sits inside main's history)
        // Merge brings in the side branch which shares c2's ancestry; native
        // git counts BOTH the main and side commits since v1 toward N.
        const mg = await seed('desc-merge');
        await mg.writeFile('a','1'); await mg.add('.'); await mg.commit('c1', A);
        await mg.writeFile('a','2'); await mg.add('.'); await mg.commit('c2', A);
        await mg.exec('tag -a v1 -m anno');
        await mg.exec('branch side');
        await mg.exec('checkout side');
        await mg.writeFile('b','x'); await mg.add('.'); await mg.commit('s1', A);
        await mg.writeFile('b','y'); await mg.add('.'); await mg.commit('s2', A);
        await mg.exec('checkout main');
        await mg.writeFile('a','3'); await mg.add('.'); await mg.commit('c3', A);
        const res = await mg.merge('side', { noFastForward: true, message: 'merge', ...A });
        const head = res.oid!;

        // BFS from merge: pop merge (extras+=1, parents c3+s2 enqueued).
        // Pop c3 (parent c2 enq). Pop s2 (parents s1 enq). Pop c2 → TAG.
        // seen at tag pop = {merge, c3, s2, c2, s1}; size=5. N = (5-1)+1 = 5.
        const out = await mg.exec('describe HEAD');
        expect(out).toBe(`v1-5-g${head.slice(0, 7)}`);
    });
});
