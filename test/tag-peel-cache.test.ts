import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import git from 'isomorphic-git';
import { MemoryGit } from '../src/index';

/**
 * Regression tests for the shared per-operation iso-git object cache on the
 * tag-peel paths (`_doLoadAllTagOids`, `showTagRefs` short-circuit,
 * `packRefs`).
 *
 * Without the cache, every `readTag` re-opens and re-indexes the repo's
 * packfiles from scratch — even for lightweight tags, where readTag does the
 * full object read before throwing. On a repo with hundreds of loose tags and
 * a multi-hundred-MB pack this multiplied into tens of GiB of transient
 * allocations (prod OOM 2026-07-13: one `git tag --points-at HEAD` on a
 * 380-tag / 718MiB-pack repo ≈ 45GiB over 7 minutes).
 *
 * The tests assert the sharing contract directly: every readTag issued by one
 * logical operation must receive the SAME cache object, so iso-git parses the
 * pack once per operation instead of once per tag.
 */
describe('tag peel shares one iso-git cache per operation', () => {
    let memGit: MemoryGit;

    beforeEach(async () => {
        memGit = new MemoryGit('tag-peel-cache');
        await memGit.init();
        await memGit.writeFile('a.txt', 'one');
        await memGit.add('.');
        await memGit.commit('c1');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    async function createAnnotatedTags(count: number): Promise<string[]> {
        const names: string[] = [];
        for (let i = 0; i < count; i++) {
            const name = `v0.0.${i}`;
            await memGit.createTag(name, { annotated: true, message: `release ${name}` });
            names.push(name);
        }
        return names;
    }

    function cachesSeenBy(spy: ReturnType<typeof vi.spyOn>): Set<unknown> {
        const caches = new Set<unknown>();
        for (const call of spy.mock.calls) {
            caches.add((call[0] as { cache?: unknown }).cache);
        }
        return caches;
    }

    it('tagsPointingAt peels every annotated tag through one shared cache', async () => {
        const names = await createAnnotatedTags(5);
        const readTagSpy = vi.spyOn(git, 'readTag');

        const matches = await memGit.tagsPointingAt('HEAD');

        // Correctness first: every annotated tag points at HEAD's commit.
        expect([...matches].sort()).toEqual([...names].sort());
        // One readTag per loose annotated tag…
        expect(readTagSpy).toHaveBeenCalledTimes(names.length);
        // …all sharing a single cache object (and never undefined).
        const caches = cachesSeenBy(readTagSpy);
        expect(caches.size).toBe(1);
        expect([...caches][0]).toBeDefined();
    });

    it('a second tagsPointingAt hits the tag-oid memo — no further readTag', async () => {
        await createAnnotatedTags(3);
        await memGit.tagsPointingAt('HEAD');
        const readTagSpy = vi.spyOn(git, 'readTag');
        await memGit.tagsPointingAt('HEAD');
        expect(readTagSpy).not.toHaveBeenCalled();
    });

    it('showTagRefs short-circuit resolves its slice through one shared cache', async () => {
        const names = await createAnnotatedTags(6);
        const readTagSpy = vi.spyOn(git, 'readTag');

        // limit < 100 with a cold tag-oid memo takes the short-circuit path
        // (_resolveTagToCommit per name).
        const refs = await memGit.showTagRefs({ limit: 4 });

        expect(refs).toHaveLength(4);
        for (const ref of refs) {
            expect(names).toContain(ref.tagName);
            expect(ref.commitOid).not.toBe(ref.refOid); // annotated: peeled
        }
        expect(readTagSpy).toHaveBeenCalledTimes(4);
        expect(cachesSeenBy(readTagSpy).size).toBe(1);
    });

    it('packRefs peels annotated tags through one shared cache and stays correct', async () => {
        const names = await createAnnotatedTags(4);
        const head = await memGit.resolveRef('HEAD');
        const readTagSpy = vi.spyOn(git, 'readTag');

        const { packed } = await memGit.packRefs();

        expect(packed).toBeGreaterThanOrEqual(names.length);
        expect(cachesSeenBy(readTagSpy).size).toBe(1);

        // The peeled `^<commit>` lines must survive the cached peel: after
        // packing, tagsPointingAt resolves entirely from packed-refs.
        const matches = await memGit.tagsPointingAt(head);
        expect([...matches].sort()).toEqual([...names].sort());
    });
});
