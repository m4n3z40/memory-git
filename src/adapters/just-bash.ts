/**
 * IFileSystem adapter that backs just-bash's virtual filesystem with a memfs Volume.
 *
 * Use to share a single in-memory filesystem between memory-git (for git ops)
 * and just-bash (for shell ops like cat / echo > / ls). Construct via the
 * `toJustBashFs(mg, opts?)` helper from the same sub-export.
 *
 * just-bash is an optional peer dependency — only install it if you import from
 * `memory-git/adapters/just-bash`.
 */

import type { IFs } from 'memfs';
import type {
    IFileSystem,
    BufferEncoding,
    FileContent,
    FsStat,
    MkdirOptions,
    RmOptions,
    CpOptions,
    ByteString,
} from 'just-bash';
import type { MemoryGit } from '../index.js';

// `ReadFileOptions`, `WriteFileOptions`, and `DirentEntry` are not re-exported
// from the just-bash package root (they live in fs/interface.js, which has no
// stable sub-path export). Declare structurally compatible shapes here so this
// file doesn't deep-import unstable paths. Structural typing satisfies the
// `IFileSystem` contract.
interface ReadFileOptions {
    encoding?: BufferEncoding | null;
}
interface WriteFileOptions {
    encoding?: BufferEncoding;
}
interface DirentEntry {
    name: string;
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
}

export type FsWriteOp =
    | 'write'
    | 'append'
    | 'rm'
    | 'mv'
    | 'mkdir'
    | 'cp'
    | 'chmod'
    | 'symlink'
    | 'link'
    | 'utimes';

export interface MemfsBackedFsOptions {
    /**
     * Called after every mutating operation. Use to track dirty paths for
     * write-behind flushing.
     */
    onWrite?: (path: string, op: FsWriteOp) => void;
    /**
     * If true, every mutating operation rejects with an `EROFS: read-only
     * file system` error instead of touching the underlying volume. Reads
     * still work normally. Useful when constructing `MemfsBackedFs`
     * directly over a raw `IFs`; when going through `toJustBashFs(mg)`,
     * the flag is taken from `mg.readOnly` automatically.
     */
    readOnly?: boolean;
}

function throwEROFS(syscall: string, path: string): never {
    const err = new Error(
        `EROFS: read-only file system, ${syscall} '${path}'`,
    ) as NodeJS.ErrnoException;
    err.code = 'EROFS';
    err.errno = -30;
    err.syscall = syscall;
    err.path = path;
    throw err;
}

export class MemfsBackedFs implements IFileSystem {
    constructor(
        private readonly vol: IFs,
        private readonly opts: MemfsBackedFsOptions = {},
    ) {}

    // -- reads --

    async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
        const enc: BufferEncoding = typeof options === 'string'
            ? options
            : ((options?.encoding ?? 'utf8') as BufferEncoding);
        const result = await this.vol.promises.readFile(path, enc as any);
        return result as string;
    }

    async readFileBuffer(path: string): Promise<Uint8Array> {
        const buf = await this.vol.promises.readFile(path);
        return buf as Uint8Array;
    }

    async readFileBytes(path: string): Promise<ByteString> {
        const buf = (await this.vol.promises.readFile(path)) as Buffer;
        return buf.toString('latin1') as unknown as ByteString;
    }

    async exists(path: string): Promise<boolean> {
        try {
            await this.vol.promises.access(path);
            return true;
        } catch {
            return false;
        }
    }

    async stat(path: string): Promise<FsStat> {
        return toFsStat(await this.vol.promises.stat(path));
    }

    async lstat(path: string): Promise<FsStat> {
        return toFsStat(await this.vol.promises.lstat(path));
    }

    async readdir(path: string): Promise<string[]> {
        const entries = (await this.vol.promises.readdir(path)) as Array<string | { toString(): string }>;
        return entries.map(e => (typeof e === 'string' ? e : e.toString()));
    }

    async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
        const entries = (await this.vol.promises.readdir(path, { withFileTypes: true })) as any[];
        return entries.map(e => ({
            name: typeof e.name === 'string' ? e.name : e.name.toString(),
            isFile: e.isFile(),
            isDirectory: e.isDirectory(),
            isSymbolicLink: e.isSymbolicLink(),
        }));
    }

    async readlink(path: string): Promise<string> {
        return (await this.vol.promises.readlink(path)) as string;
    }

    async realpath(path: string): Promise<string> {
        return (await this.vol.promises.realpath(path)) as string;
    }

    getAllPaths(): string[] {
        // `IFs` doesn't reliably expose `toJSON` (it depends on memfs internals),
        // so walk the tree synchronously via the sync API which IFs always exposes.
        const sync = this.vol as unknown as {
            readdirSync: (p: string) => string[];
            statSync: (p: string) => { isDirectory(): boolean };
        };
        const out: string[] = [];
        const walk = (dir: string): void => {
            let entries: string[];
            try { entries = sync.readdirSync(dir); }
            catch { return; }
            for (const name of entries) {
                const full = dir === '/' ? `/${name}` : `${dir}/${name}`;
                let isDir = false;
                try { isDir = sync.statSync(full).isDirectory(); } catch { continue; }
                if (isDir) walk(full);
                else out.push(full);
            }
        };
        walk('/');
        return out;
    }

    resolvePath(base: string, p: string): string {
        if (p.startsWith('/')) return p;
        const parts = (base + '/' + p).split('/').filter(Boolean);
        const stack: string[] = [];
        for (const part of parts) {
            if (part === '.') continue;
            if (part === '..') { stack.pop(); continue; }
            stack.push(part);
        }
        return '/' + stack.join('/');
    }

    // -- writes (notify onWrite hook after success) --

    async writeFile(
        path: string,
        content: FileContent,
        options?: WriteFileOptions | BufferEncoding,
    ): Promise<void> {
        if (this.opts.readOnly) throwEROFS('open', path);
        await this.vol.promises.writeFile(path, content as any, options as any);
        this.opts.onWrite?.(path, 'write');
    }

    async appendFile(
        path: string,
        content: FileContent,
        options?: WriteFileOptions | BufferEncoding,
    ): Promise<void> {
        if (this.opts.readOnly) throwEROFS('open', path);
        await this.vol.promises.appendFile(path, content as any, options as any);
        this.opts.onWrite?.(path, 'append');
    }

    async mkdir(path: string, options?: MkdirOptions): Promise<void> {
        if (this.opts.readOnly) throwEROFS('mkdir', path);
        await this.vol.promises.mkdir(path, options);
        this.opts.onWrite?.(path, 'mkdir');
    }

    async rm(path: string, options?: RmOptions): Promise<void> {
        if (this.opts.readOnly) throwEROFS('unlink', path);
        await this.vol.promises.rm(path, options);
        this.opts.onWrite?.(path, 'rm');
    }

    async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
        if (this.opts.readOnly) throwEROFS('copyfile', dest);
        const promisesCp = (this.vol.promises as any).cp;
        if (typeof promisesCp === 'function') {
            await promisesCp.call(this.vol.promises, src, dest, { recursive: !!options?.recursive });
        } else {
            await this.manualCp(src, dest, !!options?.recursive);
        }
        this.opts.onWrite?.(dest, 'cp');
    }

    async mv(src: string, dest: string): Promise<void> {
        if (this.opts.readOnly) throwEROFS('rename', src);
        await this.vol.promises.rename(src, dest);
        this.opts.onWrite?.(src, 'mv');
        this.opts.onWrite?.(dest, 'mv');
    }

    async chmod(path: string, mode: number): Promise<void> {
        if (this.opts.readOnly) throwEROFS('chmod', path);
        await this.vol.promises.chmod(path, mode);
        this.opts.onWrite?.(path, 'chmod');
    }

    async symlink(target: string, linkPath: string): Promise<void> {
        if (this.opts.readOnly) throwEROFS('symlink', linkPath);
        await this.vol.promises.symlink(target, linkPath);
        this.opts.onWrite?.(linkPath, 'symlink');
    }

    async link(existing: string, newPath: string): Promise<void> {
        if (this.opts.readOnly) throwEROFS('link', newPath);
        await this.vol.promises.link(existing, newPath);
        this.opts.onWrite?.(newPath, 'link');
    }

    async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
        if (this.opts.readOnly) throwEROFS('utimes', path);
        await this.vol.promises.utimes(path, atime, mtime);
        this.opts.onWrite?.(path, 'utimes');
    }

    // -- helpers --

    private async manualCp(src: string, dest: string, recursive: boolean): Promise<void> {
        const s = await this.vol.promises.stat(src);
        if (s.isDirectory()) {
            if (!recursive) throw new Error(`cp: -r not specified; omitting directory '${src}'`);
            await this.vol.promises.mkdir(dest, { recursive: true });
            const entries = (await this.vol.promises.readdir(src)) as string[];
            for (const entry of entries) {
                await this.manualCp(`${src}/${entry}`, `${dest}/${entry}`, true);
            }
        } else {
            const buf = await this.vol.promises.readFile(src);
            await this.vol.promises.writeFile(dest, buf as any);
        }
    }
}

function toFsStat(s: any): FsStat {
    return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        mode: s.mode,
        size: Number(s.size),
        mtime: s.mtime instanceof Date ? s.mtime : new Date(s.mtime),
    };
}

/**
 * Convenience: build an `IFileSystem` adapter from a `MemoryGit` instance so
 * just-bash and memory-git share the same in-memory Volume.
 *
 * Example:
 *   import { MemoryGit } from 'memory-git';
 *   import { toJustBashFs } from 'memory-git/adapters/just-bash';
 *   import { Bash } from 'just-bash';
 *
 *   const mg = new MemoryGit();
 *   await mg.init();
 *   const bash = new Bash({ fs: toJustBashFs(mg) });
 *   await bash.run("echo hi > /repo/hi.txt");
 *   await mg.add('hi.txt'); await mg.commit('add hi.txt');
 *
 * The adapter inherits `mg.readOnly`. The canonical pattern when one
 * consumer needs a read handle and another a write handle on the *same*
 * Volume:
 *
 *   const mg = new MemoryGit(projectId);
 *   await mg.init();
 *   const readFs  = toJustBashFs(mg.readOnlyView());  // automatically RO
 *   const writeFs = toJustBashFs(mg);                  // RW; shares Volume
 */
export function toJustBashFs(mg: MemoryGit, options?: MemfsBackedFsOptions): IFileSystem {
    return new MemfsBackedFs(mg.volume, { ...options, readOnly: mg.readOnly });
}
