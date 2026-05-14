import mri from 'mri';
import type { Command, CommandContext } from './types.js';
import type { LogOptions } from '../types.js';

function parseLogArgs(args: string[]): LogOptions & { oneline: boolean } {
    const a = mri(args, {
        alias: { n: 'max-count' },
        boolean: ['oneline', 'all'],
        string: ['author', 'since', 'until'],
    });
    return {
        depth: a['max-count'] ? Number(a['max-count']) : undefined,
        ref: a._[0] ? String(a._[0]) : undefined,
        author: a.author ? String(a.author) : undefined,
        since: a.since ? new Date(String(a.since)) : undefined,
        until: a.until ? new Date(String(a.until)) : undefined,
        oneline: !!a.oneline,
    };
}

function* formatCommit(c: {
    sha: string;
    author: string;
    email: string;
    timestamp: string;
    message: string;
}, oneline: boolean): Generator<string> {
    if (oneline) {
        yield `${c.sha.slice(0, 7)} ${c.message.trim().split('\n')[0]}`;
        return;
    }
    const date = new Date(c.timestamp).toString();
    yield `commit ${c.sha}`;
    yield `Author: ${c.author} <${c.email}>`;
    yield `Date:   ${date}`;
    yield '';
    yield `    ${c.message.trim().replace(/\n/g, '\n    ')}`;
    yield '';
}

const log: Command = {
    names: ['log'],
    async run({ mg }, args) {
        const { oneline, ...opts } = parseLogArgs(args);
        return mg.logText({ ...opts, oneline });
    },
    async *stream({ mg, signal }: CommandContext, args) {
        const { oneline, ...opts } = parseLogArgs(args);
        const commits = await mg.log(opts);
        for (const c of commits) {
            if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
            for (const line of formatCommit(c, oneline)) yield line;
        }
    },
};

export default log;
