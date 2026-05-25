/**
 * Memoize the result of an async loader for an instance's lifetime, with
 * in-flight deduplication so concurrent callers share a single load.
 *
 * Motivation: features like the tag → commit OID map are expensive to
 * build on a cold lazy-fs instance (hundreds of `readFile`s + a parse),
 * cheap to keep in memory, and queried from several places that often
 * fire concurrently (e.g. a `Promise.all` from the route handler). A
 * plain `if (cache !== null) return cache` covers the second call but
 * lets two simultaneous first calls each do the full work. This helper
 * holds the in-flight promise, so the second concurrent caller awaits
 * the same load instead of starting another one.
 *
 * Usage:
 *
 *     class Repo {
 *         private tagCache = new MemoizedAsync<Map<string, string>>();
 *         async tags() {
 *             return this.tagCache.get(() => this._loadAllTagOids());
 *         }
 *         private onWriteTouchedTags() {
 *             this.tagCache.invalidate();
 *         }
 *     }
 *
 * Semantics:
 *   - `get(loader)`: returns the cached value if present; otherwise the
 *     in-flight promise if one exists; otherwise starts the loader and
 *     caches its resolved value. `loader` is only invoked when there's
 *     neither a cached value nor an in-flight load — so callers can
 *     re-bind to a fresh closure each call without re-running.
 *   - `invalidate()`: drops both the cached value AND the in-flight
 *     marker. A loader currently in flight isn't aborted; its result
 *     just doesn't repopulate the cache (a fresh post-invalidate caller
 *     starts a new load).
 *   - `peek()`: returns the cached value or `undefined`. Doesn't trigger
 *     a load, doesn't await anything. Useful for read-only fast paths
 *     where missing the cache is acceptable.
 *   - `loading`: `true` while a `get(...)` is in flight. Mostly useful
 *     in tests to assert dedup behavior.
 */
export class MemoizedAsync<T> {
    private _value: T | undefined = undefined;
    private _loading: Promise<T> | undefined = undefined;

    /**
     * Return the cached value, or run `loader` (once) and cache its
     * result. Concurrent callers reuse the in-flight promise.
     */
    async get(loader: () => Promise<T>): Promise<T> {
        if (this._value !== undefined) return this._value;
        if (this._loading !== undefined) return this._loading;

        const promise = loader();
        this._loading = promise;
        try {
            const result = await promise;
            // Only cache if invalidate didn't race past us. Concurrent
            // followers attached to `promise` still resolve to the same
            // value; the cache simply stays empty so the next post-
            // invalidate caller triggers a fresh load.
            if (this._loading === promise) {
                this._value = result;
            }
            return result;
        } finally {
            if (this._loading === promise) {
                this._loading = undefined;
            }
        }
    }

    /** Drop the cached value and the in-flight marker. */
    invalidate(): void {
        this._value = undefined;
        this._loading = undefined;
    }

    /** Return the cached value without triggering a load. */
    peek(): T | undefined {
        return this._value;
    }

    /** True while a `get(...)` call is awaiting its loader. */
    get loading(): boolean {
        return this._loading !== undefined;
    }
}
