/**
 * Operation audit log + push-mode observer.
 *
 * Every public MemoryGit method records an entry here (timestamp, operation
 * name, sanitized params, success/error, result snapshot). Consumers can
 * pull via {@link OperationLog.getEntries}/{@link OperationLog.getStats}/{@link OperationLog.exportJson}
 * or subscribe via {@link OperationLog.subscribe} to react in real time.
 *
 * Sanitization: large `content` strings/Buffers in params are replaced with a
 * `[N bytes]` marker so the log stays cheap to keep in memory and serialize.
 */

import type { OperationLogEntry, OperationListener, OperationStats } from './types.js';

export class OperationLog {
    private entries: OperationLogEntry[] = [];
    private listeners: Set<OperationListener> = new Set();

    /**
     * Records an operation entry and notifies all subscribers. Listener
     * exceptions are swallowed (logged to stderr when `MEMORY_GIT_DEBUG` is set)
     * so a buggy observer can't break a git op.
     */
    record(
        operation: string,
        params: Record<string, unknown>,
        result: unknown = null,
        error: Error | null = null,
    ): OperationLogEntry {
        const entry: OperationLogEntry = {
            timestamp: new Date().toISOString(),
            operation,
            params: sanitizeParams(params),
            success: error === null,
            result,
            error: error ? error.message : null,
        };
        this.entries.push(entry);
        for (const cb of this.listeners) {
            try { cb(entry); } catch (e) {
                if (process.env.MEMORY_GIT_DEBUG) console.error('onOperation listener threw:', e);
            }
        }
        return entry;
    }

    /** Subscribe to entries as they are recorded. Returns an unsubscribe function. */
    subscribe(callback: OperationListener): () => void {
        this.listeners.add(callback);
        return () => { this.listeners.delete(callback); };
    }

    /** Returns a shallow copy of every recorded entry. */
    getEntries(): OperationLogEntry[] {
        return [...this.entries];
    }

    /** Drops every recorded entry. Listeners remain subscribed. */
    clear(): void {
        this.entries = [];
    }

    /** Number of recorded entries (cheap accessor — no copy). */
    get size(): number {
        return this.entries.length;
    }

    /** Aggregated counts by operation name plus success/failure totals. */
    getStats(): OperationStats {
        const stats: OperationStats = {
            total: this.entries.length,
            successful: this.entries.filter(op => op.success).length,
            failed: this.entries.filter(op => !op.success).length,
            byOperation: {},
        };
        for (const op of this.entries) {
            if (!stats.byOperation[op.operation]) {
                stats.byOperation[op.operation] = { total: 0, successful: 0, failed: 0 };
            }
            stats.byOperation[op.operation].total++;
            if (op.success) stats.byOperation[op.operation].successful++;
            else stats.byOperation[op.operation].failed++;
        }
        return stats;
    }

    /** JSON dump suitable for storing or feeding back into a model. */
    exportJson(name: string): string {
        return JSON.stringify({
            name,
            exportedAt: new Date().toISOString(),
            stats: this.getStats(),
            operations: this.entries,
        }, null, 2);
    }
}

/** Replace large content params with a `[N bytes]` marker. */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...params };
    if (sanitized.content && typeof sanitized.content === 'string' && sanitized.content.length > 100) {
        sanitized.content = `[${sanitized.content.length} bytes]`;
    }
    if (Buffer.isBuffer(sanitized.content)) {
        sanitized.content = `[Buffer: ${sanitized.content.length} bytes]`;
    }
    return sanitized;
}
