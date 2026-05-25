/**
 * Workaround for a Node.js v26 memory leak.
 *
 * isomorphic-git compresses every object it writes (add / commit / merge /
 * clone) through a "browser" deflate path:
 *
 *     new Blob([buffer]).stream().pipeThrough(new CompressionStream('deflate'))
 *
 * On Node v26 `Blob.prototype.stream()` pins the input buffer in V8 *eternal
 * handles* and never releases it, so a long-lived process leaks roughly one
 * object-sized buffer per write. The symptom is multi-GB RSS while the V8 heap
 * and the in-memory volume stay tiny — the retained memory is native (off-heap)
 * and invisible to `getMemoryUsage()`. Node 20/22/24/25 are unaffected; reads
 * are unaffected (isomorphic-git's inflate path always uses pako).
 *
 * Fix: make isomorphic-git fall back to pako (pure-JS, no leak) for compression.
 * isomorphic-git decides once, lazily, by probing `CompressionStream`. We
 * neutralize `globalThis.CompressionStream` *just long enough* for that probe to
 * run and cache "unsupported", then restore the global so unrelated code in the
 * process is unaffected. Idempotent and memoized per process (per worker isolate).
 *
 * Control via the `MEMORY_GIT_COMPRESSION` env var:
 *   - `pako`   → always force the fallback (any Node version)
 *   - `native` → never touch compression (opt out of the workaround entirely)
 *   - unset    → auto: apply only on the Node major versions known to leak (>= 26)
 */

import git from 'isomorphic-git';
import { createFsFromVolume, Volume } from 'memfs';

let primePromise: Promise<void> | null = null;

/** First leaky Node major. Node <= 25 uses native CompressionStream safely. */
const FIRST_LEAKY_NODE_MAJOR = 26;

function nodeMajor(): number {
    const m = /^(\d+)\./.exec(process.versions.node ?? '');
    return m ? Number(m[1]) : 0;
}

/** Whether to force isomorphic-git onto pako for this process. */
export function shouldForcePako(): boolean {
    const mode = process.env.MEMORY_GIT_COMPRESSION;
    if (mode === 'native') return false;
    if (mode === 'pako') return true;
    return nodeMajor() >= FIRST_LEAKY_NODE_MAJOR;
}

/**
 * Ensures isomorphic-git is using a leak-free compression backend before the
 * first object write. Cheap (one tiny throwaway deflate) and runs at most once
 * per process. Awaited by the write-capable entry points (`init`, `loadFromDisk`,
 * `clone`); calling it directly is supported for callers that bypass those.
 */
export function primeSafeCompression(): Promise<void> {
    if (primePromise) return primePromise;
    if (!shouldForcePako()) {
        primePromise = Promise.resolve();
        return primePromise;
    }
    primePromise = (async () => {
        const had = 'CompressionStream' in globalThis;
        const original = (globalThis as { CompressionStream?: unknown }).CompressionStream;
        try {
            // Hide CompressionStream so isomorphic-git's feature probe fails and
            // caches the pako fallback on its first deflate.
            (globalThis as { CompressionStream?: unknown }).CompressionStream = undefined;
            const vol = new Volume();
            const fs = createFsFromVolume(vol);
            fs.mkdirSync('/__mg_compression_probe__');
            await git.init({ fs, dir: '/__mg_compression_probe__', defaultBranch: 'main' });
            // writeBlob runs the internal deflate → caches "unsupported" → pako.
            await git.writeBlob({ fs, dir: '/__mg_compression_probe__', blob: Buffer.from('probe') });
        } catch {
            // If priming fails for any reason, leave the native path in place —
            // a working (if leaky) deflate beats a broken one.
        } finally {
            if (had) (globalThis as { CompressionStream?: unknown }).CompressionStream = original;
            else delete (globalThis as { CompressionStream?: unknown }).CompressionStream;
        }
    })();
    return primePromise;
}
