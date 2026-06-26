/**
 * Pure (I/O-free) helpers for `git for-each-ref`: version sort, ref-pattern
 * matching, and `--format` atom parsing/interpolation.
 *
 * The MemoryGit.forEachRef method (in index.ts) owns the I/O — it gathers ref
 * names, sorts/filters them with these helpers, slices to --count, and only
 * THEN resolves oids/objects for the survivors. Keeping the string-only logic
 * here makes the laziness obvious: nothing in this file reads an object.
 */

/**
 * Port of git's versioncmp (glibc strverscmp, the same automaton git ships in
 * versioncmp.c). Compares run-by-run: digit runs numerically with leading-zero
 * rules, non-digit runs bytewise. Gives v0.0.1933 > v0.0.999 > v0.0.10 > v0.0.9.
 */
export function versioncmp(s1: string, s2: string): number {
    // state bases: S_N=0, S_I=3, S_F=6, S_Z=9 (flat tables indexed base+col)
    const next_state = [
        /* S_N */ 0, 3, 9,
        /* S_I */ 0, 3, 3,
        /* S_F */ 0, 6, 6,
        /* S_Z */ 0, 6, 9,
    ];
    const CMP = 2, LEN = 3;
    const result_type = [
        /* S_N: x/x x/d x/0 d/x d/d d/0 0/x 0/d 0/0 */
        CMP, CMP, CMP, CMP, LEN, CMP, CMP, CMP, CMP,
        /* S_I */ CMP, -1, -1, +1, LEN, LEN, +1, LEN, LEN,
        /* S_F */ CMP, CMP, CMP, CMP, CMP, CMP, CMP, CMP, CMP,
        /* S_Z */ CMP, +1, +1, -1, CMP, CMP, -1, CMP, CMP,
    ];
    const isdigit = (c: number) => c >= 48 && c <= 57;
    const at = (s: string, i: number) => (i < s.length ? s.charCodeAt(i) : 0);
    let i1 = 0, i2 = 0;
    let c1 = at(s1, i1++);
    let c2 = at(s2, i2++);
    // '0' is a digit too — column is 0 (non-digit), 1 (digit), 2 ('0').
    let state = (c1 === 48 ? 1 : 0) + (isdigit(c1) ? 1 : 0);
    let diff: number;
    while ((diff = c1 - c2) === 0) {
        if (c1 === 0) return 0;
        state = next_state[state];
        c1 = at(s1, i1++);
        c2 = at(s2, i2++);
        state += (c1 === 48 ? 1 : 0) + (isdigit(c1) ? 1 : 0);
    }
    state = result_type[state * 3 + ((c2 === 48 ? 1 : 0) + (isdigit(c2) ? 1 : 0))];
    switch (state) {
        case CMP:
            return diff;
        case LEN:
            while (isdigit(at(s1, i1++))) {
                if (!isdigit(at(s2, i2++))) return 1;
            }
            return isdigit(at(s2, i2)) ? -1 : diff;
        default:
            return state;
    }
}

/** The literal leading portion of a pattern, up to the first glob metachar. */
function literalPrefix(p: string): string {
    const i = p.search(/[*?[]/);
    return i === -1 ? p : p.slice(0, i);
}

// ponytail: covers *, **, ?, and [...] classes with pathname semantics (`*`
// doesn't cross '/'). Not a full wildmatch port (no {a,b}, no FNM_LEADING_DIR
// quirks) — upgrade only if a real pattern needs it.
function globToRegExp(glob: string): RegExp {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') { re += '.*'; i++; }
            else re += '[^/]*';
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '[') {
            let j = i + 1, cls = '[';
            if (glob[j] === '!') { cls += '^'; j++; }
            while (j < glob.length && glob[j] !== ']') { cls += glob[j]; j++; }
            cls += ']';
            re += cls;
            i = j;
        } else {
            re += c.replace(/[.+^${}()|\\]/g, '\\$&');
        }
    }
    return new RegExp('^' + re + '$');
}

const hasGlob = (p: string) => /[*?[]/.test(p);

/**
 * Does `refname` match for-each-ref pattern `p`? Mirrors git's
 * match_name_as_path: a glob-free pattern matches at-or-below its path (so
 * `refs/tags` and `refs/tags/` match every tag); a glob pattern uses
 * pathname-aware wildmatch.
 */
function matchOne(p: string, refname: string): boolean {
    const plen = p.length;
    if (plen <= refname.length && refname.startsWith(p) &&
        (refname.length === plen || refname[plen] === '/' || p[plen - 1] === '/')) {
        return true;
    }
    return hasGlob(p) && globToRegExp(p).test(refname);
}

/** No patterns ⇒ everything matches. Otherwise any pattern matching wins. */
export function matchRef(patterns: string[], refname: string): boolean {
    if (patterns.length === 0) return true;
    return patterns.some(p => matchOne(p, refname));
}

/**
 * Should a namespace (e.g. `refs/tags/`) be enumerated at all given the
 * patterns? Cheap pre-filter so `refs/tags/v*` never calls listBranches /
 * listRemotes. A namespace is wanted when some pattern's literal prefix is
 * compatible with it (one is a prefix of the other).
 */
export function namespaceWanted(patterns: string[], prefix: string): boolean {
    if (patterns.length === 0) return true;
    return patterns.some(p => {
        const lp = literalPrefix(p);
        return lp.startsWith(prefix) || prefix.startsWith(lp);
    });
}

const KNOWN_PREFIXES = ['refs/heads/', 'refs/tags/', 'refs/remotes/'];

/** %(refname:short) — strip the well-known ref prefix. */
export function shortRef(refname: string): string {
    for (const pre of KNOWN_PREFIXES) {
        if (refname.startsWith(pre)) return refname.slice(pre.length);
    }
    return refname;
}

/** %(refname:strip=<n>) — drop the first n slash-separated components. */
function stripRef(refname: string, n: number): string {
    const parts = refname.split('/');
    return parts.slice(n).join('/');
}

export interface SortKey {
    name: string;
    desc: boolean;
}

/** Parse `--sort` keys (leading `-` = descending); default + tiebreak = refname. */
export function parseSortKeys(sort: string[] | undefined): SortKey[] {
    const raw = (sort && sort.length ? sort : ['refname']).map(k => {
        const desc = k.startsWith('-');
        return { name: desc ? k.slice(1) : k, desc };
    });
    // git always uses refname (ascending) as the final tiebreaker.
    if (raw[raw.length - 1].name !== 'refname') raw.push({ name: 'refname', desc: false });
    return raw;
}

function compareKey(name: string, a: string, b: string): number {
    switch (name) {
        case 'refname':
            return a < b ? -1 : a > b ? 1 : 0;
        case 'v:refname':
        case 'version:refname':
            return versioncmp(a, b);
        default:
            // objectname/creatordate/etc. would force resolving every ref
            // before sorting — refuse rather than silently break laziness.
            throw new Error(`for-each-ref: unsupported --sort key '${name}'`);
    }
}

/** Comparator over full refnames for the given (already-parsed) sort keys. */
export function makeRefComparator(keys: SortKey[]): (a: string, b: string) => number {
    return (a, b) => {
        for (const { name, desc } of keys) {
            const c = compareKey(name, a, b);
            if (c !== 0) return desc ? -c : c;
        }
        return 0;
    };
}

export const DEFAULT_FORMAT = '%(objectname) %(objecttype)\t%(refname)';

/** Which lazily-resolved fields a format string actually needs. */
export interface FormatNeeds {
    oid: boolean;
    type: boolean;
    deref: boolean;
}

/** Per-ref data the formatter consumes; everything but refname is lazy. */
export interface ResolvedRef {
    refname: string;
    oid?: string;
    type?: string;
    derefOid?: string;
    derefType?: string;
}

/** Scan a format for %(...) atoms to decide what must be resolved per ref. */
export function formatNeeds(format: string): FormatNeeds {
    const atoms = [...format.matchAll(/%\(([^)]*)\)/g)].map(m => m[1]);
    const has = (pred: (a: string) => boolean) => atoms.some(pred);
    const deref = has(a => a === '*objectname' || a === '*objecttype');
    const type = has(a => a === 'objecttype');
    const oid = deref || type || has(a => a === 'objectname' || a.startsWith('objectname:'));
    return { oid, type, deref };
}

/** Interpolate one ref's resolved data into the format string. */
export function interpolate(format: string, r: ResolvedRef): string {
    return format.replace(/%(\(([^)]*)\)|%)/g, (_m, _g, atom) => {
        if (atom === undefined) return '%'; // %%
        if (atom === 'refname') return r.refname;
        if (atom === 'refname:short') return shortRef(r.refname);
        if (atom.startsWith('refname:strip=')) return stripRef(r.refname, Number(atom.slice(14)) || 0);
        if (atom === 'objectname') return r.oid ?? '';
        if (atom === 'objectname:short') return (r.oid ?? '').slice(0, 7);
        if (atom.startsWith('objectname:short=')) return (r.oid ?? '').slice(0, Number(atom.slice(17)) || 7);
        if (atom === 'objecttype') return r.type ?? '';
        if (atom === '*objectname') return r.derefOid ?? '';
        if (atom === '*objecttype') return r.derefType ?? '';
        // Unknown atom: leave the literal text, matching nothing rather than crashing.
        return `%(${atom})`;
    });
}
