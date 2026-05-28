import mri from 'mri';
import type { Command } from './types.js';
import type { RevListOptions } from '../types.js';

interface ParsedRevList extends RevListOptions {
    count: boolean;
}

function parseArgs(args: string[]): ParsedRevList {
    const a = mri(args, {
        boolean: ['all', 'reverse', 'count'],
        alias: { 'max-count': 'n' },
    });
    const positional = a._[0] != null ? String(a._[0]) : undefined;
    // `A..B` is git's standard range syntax: commits reachable from B but not
    // from A. Detect it here so the parser produces a structured `range`
    // rather than letting "A..B" leak into the single-ref path (where
    // _resolveAny would fail and the caller would get a confusing error
    // instead of an actual range walk). `A...B` (symmetric difference) is
    // distinct and intentionally not handled — fall through to single-ref so
    // the resolver throws a clear "bad revision" error.
    let range: { from: string; to: string } | undefined;
    let ref: string | undefined;
    if (positional && positional.includes('..') && !positional.includes('...')) {
        const idx = positional.indexOf('..');
        const from = positional.slice(0, idx);
        const to = positional.slice(idx + 2);
        if (from && to) range = { from, to };
        else ref = positional; // malformed — let _resolveAny complain
    } else {
        ref = positional;
    }
    return {
        all: !!a.all,
        reverse: !!a.reverse,
        maxCount: a['max-count'] ? Number(a['max-count']) : undefined,
        count: !!a.count,
        ref,
        range,
    };
}

const revList: Command = {
    names: ['rev-list'],
    async run({ mg }, args) {
        const opts = parseArgs(args);
        if (opts.count) {
            const n = await mg.revListCount(opts);
            return String(n);
        }
        const oids = await mg.revList(opts);
        return oids.join('\n');
    },
    async *stream({ mg, signal }, args) {
        const opts = parseArgs(args);
        if (opts.count) {
            const n = await mg.revListCount(opts);
            if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
            yield String(n);
            return;
        }
        const oids = await mg.revList(opts);
        for (const oid of oids) {
            if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
            yield oid;
        }
    },
};

export default revList;
