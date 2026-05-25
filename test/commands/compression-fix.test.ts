import { describe, it, expect, afterEach } from 'vitest';
import { MemoryGit, shouldForcePako, primeSafeCompression } from '../../src/index';

/**
 * Guards the Node v26 Blob.stream() deflate-leak workaround. We can't assert
 * on RSS in a unit test (it's process-wide and version-dependent), so we verify
 * the policy logic, idempotency, that priming leaves the global intact, and
 * that writes still succeed with the fix engaged.
 */

describe('compression-fix policy (shouldForcePako)', () => {
    const original = process.env.MEMORY_GIT_COMPRESSION;
    afterEach(() => {
        if (original === undefined) delete process.env.MEMORY_GIT_COMPRESSION;
        else process.env.MEMORY_GIT_COMPRESSION = original;
    });

    it('forces pako when MEMORY_GIT_COMPRESSION=pako (any Node)', () => {
        process.env.MEMORY_GIT_COMPRESSION = 'pako';
        expect(shouldForcePako()).toBe(true);
    });

    it('never forces pako when MEMORY_GIT_COMPRESSION=native', () => {
        process.env.MEMORY_GIT_COMPRESSION = 'native';
        expect(shouldForcePako()).toBe(false);
    });

    it('auto mode tracks the running Node major (>=26 leaks)', () => {
        delete process.env.MEMORY_GIT_COMPRESSION;
        const major = Number(/^(\d+)\./.exec(process.versions.node)![1]);
        expect(shouldForcePako()).toBe(major >= 26);
    });
});

describe('primeSafeCompression', () => {
    it('is idempotent and returns the same memoized promise', () => {
        const a = primeSafeCompression();
        const b = primeSafeCompression();
        expect(a).toBe(b);
        return a; // resolves without throwing
    });

    it('leaves globalThis.CompressionStream intact after priming', async () => {
        const hadBefore = 'CompressionStream' in globalThis;
        const typeBefore = typeof (globalThis as { CompressionStream?: unknown }).CompressionStream;
        await primeSafeCompression();
        const hadAfter = 'CompressionStream' in globalThis;
        const typeAfter = typeof (globalThis as { CompressionStream?: unknown }).CompressionStream;
        expect(hadAfter).toBe(hadBefore);
        expect(typeAfter).toBe(typeBefore);
    });

    it('does not break object writes with the fix engaged', async () => {
        // Whatever backend got selected, a full write round-trip must still work.
        const mg = new MemoryGit(`compfix-${Date.now()}`);
        mg.setAuthor('T', 't@t');
        await mg.init();
        await mg.writeFile('a.txt', 'hello compression');
        await mg.add('.');
        const sha = await mg.commit('c1');
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        // And the object is readable back (deflate→inflate round-trips correctly)
        expect(await mg.readFileAtRef('a.txt', sha)).toBe('hello compression');
    });
});
