import { describe, test, expect } from 'vitest';

import { MemoizedAsync } from '../src/memoized-async.js';

describe('MemoizedAsync', () => {
    test('caches the loader result after the first call', async () => {
        const cache = new MemoizedAsync<number>();
        let loadCount = 0;
        const loader = async () => {
            loadCount++;
            return 42;
        };

        expect(await cache.get(loader)).toBe(42);
        expect(await cache.get(loader)).toBe(42);
        expect(await cache.get(loader)).toBe(42);
        expect(loadCount).toBe(1);
    });

    test('coalesces concurrent loaders on a cold cache', async () => {
        // The motivating case: Promise.all of N tagsPointingAt/describeExact
        // calls hit a fresh instance. Without dedup all N would run the
        // loader; with dedup the loader runs once and the other N-1 await
        // the same promise.
        const cache = new MemoizedAsync<number>();
        let loadCount = 0;
        const loader = async () => {
            loadCount++;
            // Yield so all concurrent callers reach the in-flight branch.
            await new Promise((resolve) => setImmediate(resolve));
            return 7;
        };

        const results = await Promise.all(
            Array.from({ length: 10 }, () => cache.get(loader)),
        );

        expect(results).toEqual(Array.from({ length: 10 }, () => 7));
        expect(loadCount).toBe(1);
    });

    test('invalidate drops the cached value', async () => {
        const cache = new MemoizedAsync<number>();
        let sentinel = 1;
        const loader = async () => sentinel;

        expect(await cache.get(loader)).toBe(1);
        sentinel = 2;
        expect(await cache.get(loader)).toBe(1); // still cached
        cache.invalidate();
        expect(await cache.get(loader)).toBe(2);
    });

    test('invalidate during an in-flight load prevents that load from populating cache', async () => {
        // Followers attached to the racing load still resolve to its
        // value, but a fresh post-invalidate caller must trigger a new
        // load — otherwise an invalidate racing with a stale read can
        // leave stale data installed.
        const cache = new MemoizedAsync<number>();
        let loadCount = 0;
        let release: (v: number) => void = () => undefined;
        const blocker = new Promise<number>((resolve) => {
            release = resolve;
        });
        const loader = async () => {
            loadCount++;
            return blocker;
        };

        const inflight = cache.get(loader); // loader running, awaiting `blocker`
        cache.invalidate();                  // user writes — invalidates mid-load
        release(99);                          // old loader settles
        await inflight;                       // follower still gets the old value

        // Next caller must re-run the loader (not see the stale 99).
        let newSentinel = 1234;
        const result = await cache.get(async () => newSentinel);
        expect(result).toBe(1234);
        expect(loadCount).toBe(1); // the second `get` used a new loader
    });

    test('peek returns the cached value without triggering a load', async () => {
        const cache = new MemoizedAsync<string>();
        expect(cache.peek()).toBeUndefined();

        await cache.get(async () => 'hi');
        expect(cache.peek()).toBe('hi');

        cache.invalidate();
        expect(cache.peek()).toBeUndefined();
    });

    test('loader rejection is not cached — next call tries again', async () => {
        const cache = new MemoizedAsync<number>();
        let attempts = 0;
        const loader = async () => {
            attempts++;
            if (attempts < 3) throw new Error('transient');
            return 8;
        };

        await expect(cache.get(loader)).rejects.toThrow(/transient/);
        await expect(cache.get(loader)).rejects.toThrow(/transient/);
        expect(await cache.get(loader)).toBe(8);
        expect(attempts).toBe(3);
    });
});
