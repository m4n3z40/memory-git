import mri from 'mri';
import type { Command, CommandContext } from './types.js';
import type { LogOptions } from '../types.js';

function parseLogArgs(args: string[]): LogOptions & { oneline: boolean; format?: string } {
    const a = mri(args, {
        alias: { n: 'max-count' },
        boolean: ['oneline', 'all'],
        string: ['author', 'since', 'until', 'format'],
    });
    return {
        depth: a['max-count'] ? Number(a['max-count']) : undefined,
        ref: a._[0] ? String(a._[0]) : undefined,
        author: a.author ? String(a.author) : undefined,
        since: a.since ? new Date(String(a.since)) : undefined,
        until: a.until ? new Date(String(a.until)) : undefined,
        oneline: !!a.oneline,
        format: a.format != null ? String(a.format) : undefined,
    };
}

const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatGitDate(isoTs: string, tzMin: number = 0): string {
    // Mirror of the formatter in src/index.ts / src/commands/show.ts. Native
    // git's default date shape: `Thu Jan 1 00:00:00 2026 +0000`.
    const adj = new Date(new Date(isoTs).getTime() - tzMin * 60_000);
    const hh = String(adj.getUTCHours()).padStart(2,'0');
    const mm = String(adj.getUTCMinutes()).padStart(2,'0');
    const ss = String(adj.getUTCSeconds()).padStart(2,'0');
    const sign = tzMin > 0 ? '-' : '+';
    const abs = Math.abs(tzMin);
    const tzH = String(Math.floor(abs/60)).padStart(2,'0');
    const tzM = String(abs%60).padStart(2,'0');
    return `${DAY[adj.getUTCDay()]} ${MON[adj.getUTCMonth()]} ${adj.getUTCDate()} ${hh}:${mm}:${ss} ${adj.getUTCFullYear()} ${sign}${tzH}${tzM}`;
}

function* formatCommit(c: {
    sha: string;
    author: string;
    email: string;
    timestamp: string;
    authorTzMin?: number;
    message: string;
    parents?: string[];
}, oneline: boolean): Generator<string> {
    if (oneline) {
        yield `${c.sha.slice(0, 7)} ${c.message.trim().split('\n')[0]}`;
        return;
    }
    yield `commit ${c.sha}`;
    if (c.parents && c.parents.length > 1) {
        yield `Merge: ${c.parents.map(p => p.slice(0, 7)).join(' ')}`;
    }
    yield `Author: ${c.author} <${c.email}>`;
    yield `Date:   ${formatGitDate(c.timestamp, c.authorTzMin)}`;
    yield '';
    yield `    ${c.message.trim().replace(/\n/g, '\n    ')}`;
    yield '';
}

const log: Command = {
    names: ['log'],
    async run({ mg }, args) {
        const { oneline, format, ...opts } = parseLogArgs(args);
        return mg.logText({ ...opts, oneline, format });
    },
    async *stream({ mg, signal }: CommandContext, args) {
        const { oneline, format, ...opts } = parseLogArgs(args);
        // --format flattens to a single expanded line per commit; bypass the
        // structured Author/Date/Merge header in that case so output matches
        // `git log --format=<fmt>` exactly.
        if (format !== undefined) {
            // Re-use logText so the format expander stays in one place.
            const text = await mg.logText({ ...opts, format });
            if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
            for (const line of text.split('\n')) yield line;
            return;
        }
        const commits = await mg.log(opts);
        for (const c of commits) {
            if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
            for (const line of formatCommit(c, oneline)) yield line;
        }
    },
};

export default log;
