/**
 * Coalesce concurrent callers onto a single in-flight async computation,
 * WITHOUT caching the resolved value.
 *
 * This is the sibling of {@link MemoizedAsync}. MemoizedAsync is for values
 * that are expensive to load and stable until an explicit invalidation (tag
 * map, current branch). InFlightAsync is for values that are expensive to
 * compute and change with the working tree on every write — the status matrix
 * being the canonical case. Caching such a value across calls would be a
 * staleness bug, but a burst of callers that fire in the same tick
 * (`Promise.all([status(), diff(), commit-guard])`) are all asking about the
 * exact same filesystem state and can safely share one computation.
 *
 * Semantics:
 *   - `run(loader)`: if a computation is already in flight, return its promise;
 *     otherwise start `loader()` and hold its promise only until it settles.
 *     The resolved value is never retained — the next call after settlement
 *     starts a fresh computation, so any intervening write is reflected.
 *   - The in-flight promise is dropped on both fulfilment and rejection, so a
 *     failed computation doesn't wedge subsequent callers.
 *
 * Correctness note: this only shares work among callers that overlap in time.
 * A caller that starts after the previous computation settled always gets a
 * fresh build, so a write that is awaited before the next read is fully
 * reflected. Callers that race a write without awaiting it have undefined
 * ordering with or without this helper — it never makes that worse.
 */
export class InFlightAsync<T> {
    private _pending: Promise<T> | undefined = undefined;

    /** Share the in-flight computation if one exists, else start a new one. */
    run(loader: () => Promise<T>): Promise<T> {
        if (this._pending !== undefined) return this._pending;
        const promise = loader();
        this._pending = promise;
        const clear = (): void => {
            if (this._pending === promise) this._pending = undefined;
        };
        promise.then(clear, clear);
        return promise;
    }

    /** True while a computation is in flight. Mainly for tests. */
    get inFlight(): boolean {
        return this._pending !== undefined;
    }
}
