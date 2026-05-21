import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryGit } from '../../src/index';
import { MemfsBackedFs, toJustBashFs, type FsWriteOp } from '../../src/adapters/just-bash';

describe('MemoryGit v3.1 additions', () => {
    let mg: MemoryGit;

    beforeEach(async () => {
        mg = new MemoryGit('v31-test');
        await mg.init();
    });

    describe('volume getter', () => {
        it('exposes the in-memory IFs', () => {
            expect(mg.volume).toBe(mg.fs);
            expect(typeof mg.volume.promises.readFile).toBe('function');
        });

        it('mutations via volume are visible to git operations', async () => {
            await mg.volume.promises.writeFile('/repo/hello.txt', 'hi');
            await mg.add('hello.txt');
            const sha = await mg.commit('add hello via volume');
            expect(sha).toMatch(/^[0-9a-f]{40}$/);
        });
    });

    describe('onOperation observer', () => {
        it('invokes the callback after each operation', async () => {
            const seen: string[] = [];
            mg.onOperation(op => seen.push(op.operation));
            await mg.writeFile('a.txt', 'a');
            await mg.add('a.txt');
            expect(seen).toContain('writeFile');
            expect(seen).toContain('add');
        });

        it('returns an unsubscribe function', async () => {
            const seen: string[] = [];
            const unsub = mg.onOperation(op => seen.push(op.operation));
            await mg.writeFile('a.txt', 'a');
            const before = seen.length;
            unsub();
            await mg.writeFile('b.txt', 'b');
            expect(seen.length).toBe(before);
        });

        it("doesn't break the git op when a listener throws", async () => {
            mg.onOperation(() => { throw new Error('listener boom'); });
            await expect(mg.writeFile('a.txt', 'a')).resolves.toBe(true);
            expect(await mg.readFile('a.txt')).toBe('a');
        });
    });

    describe('AbortSignal on exec', () => {
        it('rejects immediately with AbortError when signal is pre-aborted', async () => {
            const ctrl = new AbortController();
            ctrl.abort();
            await expect(mg.exec('status', { signal: ctrl.signal }))
                .rejects.toMatchObject({ name: 'AbortError' });
        });

        it('rejects with AbortError on clone when signal aborts mid-flight', async () => {
            const ctrl = new AbortController();
            // Abort on next microtask
            queueMicrotask(() => ctrl.abort());
            await expect(mg.clone('http://invalid.test/repo.git', { signal: ctrl.signal }))
                .rejects.toMatchObject({ name: 'AbortError' });
        });

        it('passes through when signal is provided but not aborted', async () => {
            const ctrl = new AbortController();
            await expect(mg.exec('status', { signal: ctrl.signal }))
                .resolves.toBeDefined();
        });
    });

    describe('execStream', () => {
        beforeEach(async () => {
            mg.setAuthor('Tester', 't@example.com');
            await mg.writeFile('a.txt', 'a');
            await mg.add('a.txt');
            await mg.commit('first');
            await mg.writeFile('b.txt', 'b');
            await mg.add('b.txt');
            await mg.commit('second');
            await mg.writeFile('c.txt', 'c');
            await mg.add('c.txt');
            await mg.commit('third');
        });

        it('yields per commit for git log --oneline', async () => {
            const lines: string[] = [];
            for await (const line of mg.execStream('git log --oneline')) {
                lines.push(line);
            }
            expect(lines).toHaveLength(3);
            for (const l of lines) expect(l).toMatch(/^[0-9a-f]{7} /);
        });

        it('yields per path for ls-files', async () => {
            const lines: string[] = [];
            for await (const f of mg.execStream('git ls-files')) lines.push(f);
            expect(lines.sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
        });

        it('yields per OID for rev-list HEAD', async () => {
            const oids: string[] = [];
            for await (const oid of mg.execStream('git rev-list HEAD')) oids.push(oid);
            expect(oids).toHaveLength(3);
            for (const oid of oids) expect(oid).toMatch(/^[0-9a-f]{40}$/);
        });

        it('falls back to splitting one-shot output (status --short)', async () => {
            await mg.writeFile('d.txt', 'd'); // unstaged
            const lines: string[] = [];
            for await (const line of mg.execStream('git status --short')) lines.push(line);
            expect(lines.some(l => l.includes('d.txt'))).toBe(true);
        });

        it('aborts mid-stream when the signal fires', async () => {
            const ctrl = new AbortController();
            const lines: string[] = [];
            await expect((async () => {
                for await (const line of mg.execStream('git log --oneline', { signal: ctrl.signal })) {
                    lines.push(line);
                    if (lines.length === 1) ctrl.abort();
                }
            })()).rejects.toMatchObject({ name: 'AbortError' });
            expect(lines.length).toBeLessThan(3);
        });
    });
});

describe('MemfsBackedFs (just-bash IFileSystem adapter)', () => {
    let mg: MemoryGit;
    let fs: MemfsBackedFs;
    let writes: Array<[string, FsWriteOp]>;

    beforeEach(async () => {
        mg = new MemoryGit('adapter-test');
        await mg.init();
        writes = [];
        fs = new MemfsBackedFs(mg.volume, { onWrite: (p, op) => writes.push([p, op]) });
    });

    it('writeFile + readFile round-trip', async () => {
        await fs.writeFile('/repo/x.txt', 'hello');
        expect(await fs.readFile('/repo/x.txt')).toBe('hello');
        expect(writes).toContainEqual(['/repo/x.txt', 'write']);
    });

    it('appendFile appends and notifies', async () => {
        await fs.writeFile('/repo/x.txt', 'a');
        await fs.appendFile('/repo/x.txt', 'b');
        expect(await fs.readFile('/repo/x.txt')).toBe('ab');
        expect(writes.some(([, op]) => op === 'append')).toBe(true);
    });

    it('exists/stat/lstat', async () => {
        await fs.writeFile('/repo/y.txt', 'y');
        expect(await fs.exists('/repo/y.txt')).toBe(true);
        expect(await fs.exists('/repo/nope.txt')).toBe(false);
        const st = await fs.stat('/repo/y.txt');
        expect(st.isFile).toBe(true);
        expect(st.isDirectory).toBe(false);
        const ls = await fs.lstat('/repo/y.txt');
        expect(ls.isFile).toBe(true);
    });

    it('mkdir + readdir + readdirWithFileTypes', async () => {
        await fs.mkdir('/repo/dir1', { recursive: true });
        await fs.writeFile('/repo/dir1/a.txt', 'a');
        await fs.mkdir('/repo/dir1/sub', { recursive: true });
        const names = await fs.readdir('/repo/dir1');
        expect(names.sort()).toEqual(['a.txt', 'sub']);
        const entries = await fs.readdirWithFileTypes('/repo/dir1');
        const byName = new Map(entries.map(e => [e.name, e]));
        expect(byName.get('a.txt')?.isFile).toBe(true);
        expect(byName.get('sub')?.isDirectory).toBe(true);
        expect(writes.some(([p, op]) => op === 'mkdir' && p === '/repo/dir1')).toBe(true);
    });

    it('rm file and recursive directory', async () => {
        await fs.mkdir('/repo/del', { recursive: true });
        await fs.writeFile('/repo/del/a.txt', 'a');
        await fs.rm('/repo/del/a.txt');
        expect(await fs.exists('/repo/del/a.txt')).toBe(false);
        await fs.rm('/repo/del', { recursive: true, force: true });
        expect(await fs.exists('/repo/del')).toBe(false);
    });

    it('cp copies files and recursive directories', async () => {
        await fs.mkdir('/repo/src', { recursive: true });
        await fs.writeFile('/repo/src/a.txt', 'A');
        await fs.writeFile('/repo/src/b.txt', 'B');
        await fs.cp('/repo/src', '/repo/dst', { recursive: true });
        expect((await fs.readdir('/repo/dst')).sort()).toEqual(['a.txt', 'b.txt']);
        expect(await fs.readFile('/repo/dst/a.txt')).toBe('A');
        expect(writes.some(([, op]) => op === 'cp')).toBe(true);
    });

    it('mv renames', async () => {
        await fs.writeFile('/repo/m1.txt', 'm');
        await fs.mv('/repo/m1.txt', '/repo/m2.txt');
        expect(await fs.exists('/repo/m1.txt')).toBe(false);
        expect(await fs.readFile('/repo/m2.txt')).toBe('m');
        const ops = writes.filter(([, op]) => op === 'mv').map(([p]) => p);
        expect(ops).toEqual(expect.arrayContaining(['/repo/m1.txt', '/repo/m2.txt']));
    });

    it('chmod / utimes notify onWrite', async () => {
        await fs.writeFile('/repo/cm.txt', 'x');
        await fs.chmod('/repo/cm.txt', 0o644);
        await fs.utimes('/repo/cm.txt', new Date(), new Date());
        expect(writes.some(([, op]) => op === 'chmod')).toBe(true);
        expect(writes.some(([, op]) => op === 'utimes')).toBe(true);
    });

    it('symlink + readlink + realpath', async () => {
        await fs.writeFile('/repo/target.txt', 't');
        await fs.symlink('/repo/target.txt', '/repo/link.txt');
        expect(await fs.readlink('/repo/link.txt')).toBe('/repo/target.txt');
        expect(await fs.realpath('/repo/link.txt')).toBe('/repo/target.txt');
        expect(writes.some(([, op]) => op === 'symlink')).toBe(true);
    });

    it('link (hard) notifies onWrite', async () => {
        await fs.writeFile('/repo/orig.txt', 'o');
        await fs.link('/repo/orig.txt', '/repo/hard.txt');
        expect(await fs.readFile('/repo/hard.txt')).toBe('o');
        expect(writes.some(([, op]) => op === 'link')).toBe(true);
    });

    it('resolvePath handles abs, .. and .', () => {
        expect(fs.resolvePath('/repo', '/abs')).toBe('/abs');
        expect(fs.resolvePath('/repo/sub', '../up')).toBe('/repo/up');
        expect(fs.resolvePath('/repo', './a/b')).toBe('/repo/a/b');
        expect(fs.resolvePath('/repo', 'x')).toBe('/repo/x');
    });

    it('getAllPaths reflects current Volume state', async () => {
        await fs.writeFile('/repo/g1.txt', 'g');
        const paths = fs.getAllPaths();
        expect(paths).toContain('/repo/g1.txt');
    });

    it('readFileBuffer returns raw bytes', async () => {
        await fs.writeFile('/repo/bin', new Uint8Array([0, 1, 2, 3]));
        const buf = await fs.readFileBuffer('/repo/bin');
        expect(Array.from(buf)).toEqual([0, 1, 2, 3]);
    });

    it('toJustBashFs returns an instance bound to the MemoryGit volume', async () => {
        const adapter = toJustBashFs(mg);
        await adapter.writeFile('/repo/shared.txt', 'shared', undefined);
        // memory-git can see it through the shared Volume
        expect(await mg.readFile('shared.txt')).toBe('shared');
    });

    it('integration: writes through adapter are git-addable', async () => {
        const adapter = toJustBashFs(mg);
        await adapter.writeFile('/repo/u.txt', 'via adapter', undefined);
        mg.setAuthor('A', 'a@a');
        await mg.add('u.txt');
        const sha = await mg.commit('add via adapter');
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
    });

    describe('readOnly (explicit adapter option)', () => {
        let ro: MemfsBackedFs;
        let roWrites: Array<[string, FsWriteOp]>;

        beforeEach(async () => {
            await mg.volume.promises.writeFile('/repo/seed.txt', 'seed');
            await mg.volume.promises.mkdir('/repo/seeddir', { recursive: true });
            await mg.volume.promises.writeFile('/repo/seeddir/inner.txt', 'inner');
            roWrites = [];
            ro = new MemfsBackedFs(mg.volume, {
                readOnly: true,
                onWrite: (p, op) => roWrites.push([p, op]),
            });
        });

        it('reads still work', async () => {
            expect(await ro.readFile('/repo/seed.txt')).toBe('seed');
            expect(await ro.exists('/repo/seed.txt')).toBe(true);
            const names = await ro.readdir('/repo/seeddir');
            expect(names).toContain('inner.txt');
        });

        it.each([
            ['writeFile', () => ro.writeFile('/repo/x.txt', 'x')],
            ['appendFile', () => ro.appendFile('/repo/seed.txt', '!')],
            ['mkdir', () => ro.mkdir('/repo/newdir')],
            ['rm', () => ro.rm('/repo/seed.txt')],
            ['cp', () => ro.cp('/repo/seed.txt', '/repo/seed-copy.txt')],
            ['mv', () => ro.mv('/repo/seed.txt', '/repo/moved.txt')],
            ['chmod', () => ro.chmod('/repo/seed.txt', 0o644)],
            ['symlink', () => ro.symlink('/repo/seed.txt', '/repo/seed-link')],
            ['link', () => ro.link('/repo/seed.txt', '/repo/seed-hard')],
            ['utimes', () => ro.utimes('/repo/seed.txt', new Date(), new Date())],
        ])('%s rejects with EROFS', async (_name, fn) => {
            await expect(fn()).rejects.toMatchObject({ code: 'EROFS' });
        });

        it('failed writes do not mutate the volume or fire onWrite', async () => {
            await expect(ro.writeFile('/repo/x.txt', 'x')).rejects.toMatchObject({ code: 'EROFS' });
            expect(await ro.exists('/repo/x.txt')).toBe(false);
            expect(roWrites).toEqual([]);
        });
    });

    it('toJustBashFs default is writable when mg is writable', async () => {
        const adapter = toJustBashFs(mg);
        await adapter.writeFile('/repo/ok.txt', 'ok', undefined);
        expect(await adapter.readFile('/repo/ok.txt')).toBe('ok');
    });
});

describe('MemoryGit.readOnlyView()', () => {
    let mg: MemoryGit;
    let view: MemoryGit;

    beforeEach(async () => {
        mg = new MemoryGit('shared');
        await mg.init();
        mg.setAuthor('A', 'a@a');
        view = mg.readOnlyView();
    });

    it('view reports readOnly=true while parent stays writable', () => {
        expect(view.readOnly).toBe(true);
        expect(mg.readOnly).toBe(false);
    });

    it('view shares the same Volume — parent writes are visible to the view live', async () => {
        await mg.writeFile('hello.txt', 'hi');
        expect(await view.readFile('hello.txt')).toBe('hi');
        await mg.add('hello.txt');
        const sha = await mg.commit('first');
        const log = await view.log();
        expect(log).toHaveLength(1);
        expect(log[0].sha).toBe(sha);
    });

    it('view sees parent isInitialized / author / realDir live (delegated)', async () => {
        // isInitialized was true before view creation; flip it via another bootstrap path
        // and verify the view tracks it.
        const fresh = new MemoryGit('fresh');
        const freshView = fresh.readOnlyView();
        expect(freshView.readOnly).toBe(true);
        // Not initialized yet — parent and view agree.
        expect(fresh.isInitialized).toBe(false);
        expect(freshView.isInitialized).toBe(false);
        await fresh.init();
        // Parent's mutation flows through the view's delegating getter.
        expect(fresh.isInitialized).toBe(true);
        expect(freshView.isInitialized).toBe(true);

        // Author flows through similarly.
        fresh.setAuthor('Bob', 'b@b');
        expect(freshView.author).toEqual({ name: 'Bob', email: 'b@b' });
    });

    it('every mutating method on the view throws EROFS', async () => {
        await expect(view.writeFile('x', 'x')).rejects.toMatchObject({ code: 'EROFS' });
        await expect(view.add('x')).rejects.toMatchObject({ code: 'EROFS' });
        await expect(view.commit('x')).rejects.toMatchObject({ code: 'EROFS' });
        await expect(view.createBranch('feat')).rejects.toMatchObject({ code: 'EROFS' });
        await expect(view.init()).rejects.toMatchObject({ code: 'EROFS' });
        await expect(view.config('user.name', 'Bob')).rejects.toMatchObject({ code: 'EROFS' });
        expect(() => view.setAuthor('x', 'x@x')).toThrowError(
            expect.objectContaining({ code: 'EROFS' }),
        );
        await expect(view.exec('git add foo')).rejects.toMatchObject({ code: 'EROFS' });
    });

    it('reads keep working on the view (no EROFS leakage)', async () => {
        await mg.config('user.name', 'Alice');
        await mg.writeFile('r.txt', 'r');
        await mg.add('r.txt');
        await mg.commit('seed');
        expect(await view.readFile('r.txt')).toBe('r');
        expect(await view.config('user.name')).toBe('Alice');
        expect((await view.log()).length).toBe(1);
        const status = await view.exec('git status --short');
        expect(typeof status).toBe('string');
    });

    it('the view is permanently read-only — `_readOnly` is locked at the descriptor level', () => {
        expect(view.readOnly).toBe(true);
        // Sanity-check that the contract isn't trivially bypassable.
        expect(() => {
            (view as unknown as { _readOnly: boolean })._readOnly = false;
        }).toThrow(TypeError);
        expect(view.readOnly).toBe(true);
    });

    it('toJustBashFs(view) is automatically read-only; toJustBashFs(parent) is RW on same Volume', async () => {
        await mg.writeFile('seed.txt', 'seed');

        const readFs = toJustBashFs(view);
        const writeFs = toJustBashFs(mg);

        // Read handle: sees the file, can't mutate.
        expect(await readFs.readFile('/repo/seed.txt')).toBe('seed');
        await expect(readFs.writeFile('/repo/x.txt', 'x', undefined))
            .rejects.toMatchObject({ code: 'EROFS' });

        // Write handle: writes pass through, and the view (same Volume) sees them.
        await writeFs.writeFile('/repo/via-write.txt', 'w', undefined);
        expect(await readFs.readFile('/repo/via-write.txt')).toBe('w');
    });
});
