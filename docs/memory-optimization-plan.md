# Memory & `add('.')` optimization plan

Living plan for reducing per-instance footprint in production. Updated as
findings are validated.

> **Status (Phase 0 + Phase 1 library items shipped).** Done in-repo:
> `getMemoryUsage()` breakdown (no `toJSON`), `add('.')` fix (recording-fs feeds
> `_dirtyFiles` + HEAD-gated post-load seed), bounded `OperationLog`
> (`maxLogEntries`). Tests: `test/add-dirty-fastpath.test.ts`,
> `test/memory-usage-and-log.test.ts` (full suite green, 485 tests). App-side
> items (1a client tweak now optional, 1e eviction-leak audit, 1f gc trigger)
> and Phase 2/3 remain.

## Production context (from ops)

- Pool of **25** live `MemoryGit` instances; oldest evicted on memory ceiling
  or **10 min idle**. Eviction already exists — the problem is each instance is
  too heavy.
- Workload **iterates the working tree** (`add '.'`, `status`, build steps),
  so **lazy mode does not help** (everything materializes anyway). Focus is on
  shrinking per-instance cost, not deferring loads.

## Where the memory goes (per instance)

Each instance owns a full memfs `Volume` (`src/index.ts:240`). With N concurrent
projects you hold N copies of:

1. **Working tree** — every non-ignored file as a Buffer (`disk-sync.ts:274`).
   Resident and unavoidable for the iterate-everything profile.
2. **The entire `.git/`, always** — loaded regardless of ignore rules
   (`disk-sync.ts:259-261`), including the full history packfiles. `status`/`add`
   only need `index` + `HEAD` + refs + HEAD's trees/blobs, **not** old history.
   In mature repos `.git` often rivals or exceeds the checkout → prime reducible
   chunk.

isomorphic-git is called **without** a `cache` everywhere, so there is no
growing iso-git object cache (verified). The growth is the resident Volumes,
plus the avoidable churn below.

## Validated findings

### `add('.')` re-hashes everything after load and misses build writes

`add('.')` already has a dirty-set fast-path (`index.ts:835-851`) and batches
into one `git.add` (`index.ts:866`). Two surrounding issues kill it:

1. **Blanket post-load seed** (`index.ts:699-700`): after `loadFromDisk`, *all*
   working-tree files are marked dirty, so the first `add('.')` re-reads,
   re-hashes (SHA-1) and re-deflates **every** file — even on a clean checkout
   whose loaded `.git/index` already matches the worktree.
2. **Dirty-tracking asymmetry**: build tools write through `toJustBashFs(mg)` →
   `mg.volume` (= `this.fs`, the recording-fs layer, `index.ts:354`). Those
   writes populate `_unpersisted` (what `getDirtyPaths()` reports) but **not**
   `_dirtyFiles` (what `add('.')` reads). So `add('.')` **silently misses files
   the build created** after load.

**Benchmark** (`benchmarks/add-bench.js`, 2000 files, 20 modified + 5 new):

| `add('.')`        | add time | loose objs written | heap Δ   | new files staged |
|-------------------|---------:|-------------------:|---------:|-----------------:|
| before fix        | 155.7 ms | 2000               | +3.21 MB | **0 / 5 (✗)**    |
| after fix         |   8.2 ms | 25                 |  ~0 MB   | 5 / 5 (✓)        |

→ **~19× faster, 1975 fewer loose objects, and the missed-files bug is fixed.**
Clean checkout (zero changes): `add('.')` went from re-hashing all 2000 (159 ms,
+3.2 MB) to an instant no-op. The fix is in the library, so `add('.')` is now
correct + cheap by default — `add(getDirtyPaths())` becomes equivalent, not
required. Across 25 pooled instances this removes the redundant loose-object
bloat in memfs.

### `getMemoryUsage()` is a measurement bomb

`index.ts:3669` calls `vol.toJSON()`, cloning the whole Volume into a JS object —
each call transiently **doubles** that instance's RAM, and counts binary
`Buffer` content as 0 bytes. If the eviction "memory ceiling" trigger samples
this, measuring inflates the very metric that drives eviction.

### `OperationLog` is unbounded

`operation-log.ts:38` pushes one entry per op forever (small summaries, not
blobs — confirmed), per instance. A slow leak for long-lived pooled instances.

### Eviction teardown can leak the Volume

`OperationLog.subscribe()` holds listeners in a `Set` (`operation-log.ts:17`).
If eviction drops the reference without unsubscribing, the listener closure can
pin the instance and the Volume never GCs — eviction "runs" but RAM doesn't
drop. (App-level; verify.)

## Plan

### Phase 0 — Measure (prerequisite)

- **Fix `getMemoryUsage()`**: recursive Volume walk (no `toJSON`) returning
  `workingTreeBytes` vs `gitBytes`, and within `.git`: `packBytes` /
  `looseBytes` / `looseCount`. Cheap and correct. Run against real prod repos →
  **confirm the hypothesis that `.git` history dominates** before paying for
  Phase 2.
- **`benchmarks/add-bench.js`** ✅ done — validates the add path.

### Phase 1 — Quick wins (low risk)

- **1a. `add('.')` → `add(getDirtyPaths())` (client-side).** ⚪ Now optional —
  1b made `add('.')` itself fast + correct, so clients need no change. The
  pattern still works if preferred:
  ```js
  const changed = mg.getDirtyPaths().filter(p => !p.startsWith('.git/'));
  if (changed.length) await mg.add(changed);
  ```
- **1b. `add('.')` library fix.** ✅ Done. The recording-fs callback now feeds
  `_dirtyFiles` for working-tree paths (`.git/` filtered), so adapter/build
  writes are staged. The blanket post-load seed is gone: eager mode seeds only
  on a fresh import (unborn HEAD), a loaded committed checkout seeds nothing
  (`{stageWorkingTree:true}` forces the old behavior); lazy mode keeps the
  legacy seed (probing HEAD would fault refs). `_dirtyFiles` is cleared after
  load; existing post-checkout/reset/merge clears remain the reconciliation
  point.
- **1c. Bound `OperationLog`** with a `maxLogEntries` ring buffer. ✅ Done —
  constructor option, default unbounded (opt-in to preserve behavior); drops
  oldest past the cap.
- **1d. Fix `getMemoryUsage()`** ✅ Done — stat walk over the raw volume (no
  `toJSON` clone, counts binary by real size), returns a `breakdown` of
  workingTree vs git, and pack/loose/looseObjects within `.git`. Also Phase 0.
- **1e. Eviction teardown audit** (app, TODO): unsubscribe listeners + `clear()`
  on evict; drop any `readOnlyView()` siblings (shared state, `index.ts:302-312`).
- **1f. Periodic in-memory `gc()`** (app/operational, TODO) for long-lived
  instances — collapses accumulated loose objects (each = a memfs node) into one
  pack. Trigger on `getMemoryUsage().breakdown.git.looseObjects`.

### Phase 2 — Reduce `.git` residency (big lever, gated on Phase 0)

Only if Phase 0 confirms packs dominate. Preferred: **split-fs** — an `fs` proxy
routing `<dir>/.git/objects/pack/` (and optionally the whole object store) to a
**local fast disk** (tmpfs/SSD scratch, *not* EFS), keeping the working tree +
`.git/{index,HEAD,refs,packed-refs,config}` in memfs. `status`/`add` never need
history packs in RAM; historical reads hit the OS page cache (shared across
instances of the same repo). Risk: iso-git re-reads packs per op without a
cache — mitigate with local disk and/or a per-instance cache **with eviction-time
cleanup** (else one leak trades for another).

### Phase 3 — Pool memory-aware budget

With real per-instance bytes from Phase 0, replace the **count**-based pool
limit (25) with a **byte budget** (more small projects, fewer giants) and
revisit the 10-min idle if idle instances hold significant RAM.

## Sequence

```
Phase 0 (measure) ──┬── 1a (client, ship now) ──────────────► validated relief
                    ├── 1b/1c/1d (lib quick wins)
                    ├── 1e (eviction leak audit — independent, do early)
                    └── decide ─► Phase 2 (only if .git dominates) ─► Phase 3
```

Start with **Phase 0 + 1a**: 1a ships the validated 20× win and the correctness
fix today; Phase 0 unblocks the Phase 2 decision. Phase 2 holds the largest
memory win for this profile but is the costliest — don't start it without the
Phase 0 numbers.
