/**
 * Transaction-faithful in-memory Firestore fake, for tests.
 *
 * WHY THIS EXISTS: the real Firebase emulators cannot always run (they need a
 * JAR downloaded from storage.googleapis.com). The concurrency guarantees this
 * project depends on come from Firestore's OPTIMISTIC transactions, so the fake
 * reproduces exactly that behaviour rather than serialising everything behind
 * a mutex (which would make every concurrency test trivially pass):
 *
 *   - Each document has a monotonically increasing version.
 *   - A transaction records the version of every document it READS.
 *   - At commit, if ANY read document's version changed since it was read,
 *     the transaction is ABORTED and the callback is RE-RUN (Firestore retries
 *     contended transactions the same way).
 *   - Commit itself is atomic (synchronous critical section).
 *   - Callbacks may `await` arbitrary promises between reads and writes, so a
 *     test can force a real interleaving of two in-flight transactions.
 *
 * It implements only what the production code uses: collection/doc/get/set
 * (with merge)/delete, where('f','==',v)/'in', orderBy('__name__'),
 * startAfter, limit, count-independent batch, and runTransaction.
 *
 * It is NOT shipped in the production bundle: only tests import it.
 */

type Data = Record<string, any>;
export interface Stored { data: Data; version: number }

export interface FakeFirestoreOptions {
  /** Test hook awaited after every transactional read, to force interleavings. */
  afterTxRead?: (path: string) => Promise<void> | void;
  /** Maximum transaction attempts before giving up (Firestore uses 5). */
  maxAttempts?: number;
}

const clone = <T,>(v: T): T => (v === undefined ? v : structuredClone(v));

export class DocSnapshot {
  constructor(public readonly id: string, public readonly ref: DocRef, private readonly _data: Data | undefined) {}
  get exists() { return this._data !== undefined; }
  data() { return this._data === undefined ? undefined : clone(this._data); }
}

export class DocRef {
  constructor(private readonly fs: FakeFirestore, public readonly path: string) {}
  get id() { return this.path.split('/').pop()!; }
  async get(): Promise<DocSnapshot> {
    const s = this.fs._store.get(this.path);
    return new DocSnapshot(this.id, this, s ? s.data : undefined);
  }
  async set(data: Data, opts?: { merge?: boolean }) { this.fs._commitWrite(this.path, data, opts?.merge); }
  async delete() { this.fs._store.delete(this.path); }
  collection(name: string) { return new CollectionRef(this.fs, `${this.path}/${name}`); }
}

class Query {
  constructor(
    protected readonly fs: FakeFirestore,
    protected readonly prefix: string,
    protected readonly filters: Array<[string, string, any]> = [],
    protected readonly _limit: number | null = null,
    protected readonly _after: string | null = null,
  ) {}
  where(field: string, op: string, value: any) {
    return new Query(this.fs, this.prefix, [...this.filters, [field, op, value]], this._limit, this._after);
  }
  orderBy(_field: string) { return this; }
  limit(n: number) { return new Query(this.fs, this.prefix, this.filters, n, this._after); }
  startAfter(snap: DocSnapshot) { return new Query(this.fs, this.prefix, this.filters, this._limit, snap.ref.path); }
  async get() {
    let docs = [...this.fs._store.entries()]
      .filter(([p]) => p.startsWith(this.prefix + '/') && !p.slice(this.prefix.length + 1).includes('/'))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .filter(([, s]) => this.filters.every(([f, op, v]) => {
        const actual = s.data[f];
        if (op === '==') return actual === v;
        if (op === '<') return actual !== undefined && actual < v;
        if (op === '<=') return actual !== undefined && actual <= v;
        if (op === '>') return actual !== undefined && actual > v;
        if (op === 'in') return Array.isArray(v) && v.includes(actual);
        throw new Error(`fake firestore: unsupported operator ${op}`);
      }));
    if (this._after) docs = docs.filter(([p]) => p > this._after!);
    if (this._limit !== null) docs = docs.slice(0, this._limit);
    const snaps = docs.map(([p, s]) => new DocSnapshot(p.split('/').pop()!, new DocRef(this.fs, p), s.data));
    return { empty: snaps.length === 0, size: snaps.length, docs: snaps };
  }
}

export class CollectionRef extends Query {
  constructor(fs: FakeFirestore, public readonly path: string) { super(fs, path); }
  doc(id: string) { return new DocRef(this.fs, `${this.path}/${id}`); }
}

export class TransactionConflictError extends Error {
  constructor() { super('fake firestore: transaction aborted due to contention'); }
}

export class FakeFirestore {
  readonly _store: Map<string, Stored>;
  /** Counters tests can assert on. */
  stats = { transactionAttempts: 0, transactionAborts: 0, commits: 0 };
  private opts: FakeFirestoreOptions;
  /** `store` lets the desktop build supply a persisting Map; tests use the default in-memory one. */
  constructor(opts: FakeFirestoreOptions = {}, store?: Map<string, Stored>) { this.opts = opts; this._store = store ?? new Map(); }
  /** Install/replace the interleaving hook after seeding, so setup writes are not affected. */
  setAfterTxRead(hook: FakeFirestoreOptions['afterTxRead']) { this.opts = { ...this.opts, afterTxRead: hook }; }

  collection(name: string) { return new CollectionRef(this, name); }
  doc(path: string) { return new DocRef(this, path); }
  batch() {
    const ops: Array<() => void> = [];
    return {
      delete: (ref: DocRef) => { ops.push(() => this._store.delete(ref.path)); },
      set: (ref: DocRef, data: Data, o?: { merge?: boolean }) => { ops.push(() => this._commitWrite(ref.path, data, o?.merge)); },
      commit: async () => { for (const op of ops) op(); },
    };
  }

  _commitWrite(path: string, data: Data, merge?: boolean) {
    const prev = this._store.get(path);
    const next = merge && prev ? { ...prev.data, ...clone(data) } : clone(data);
    for (const [k, v] of Object.entries(next)) if (v === undefined) throw new Error(`fake firestore: undefined value for field "${k}" (real Firestore rejects this)`);
    this._store.set(path, { data: next, version: (prev?.version ?? 0) + 1 });
  }

  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const max = this.opts.maxAttempts ?? 5;
    for (let attempt = 1; ; attempt++) {
      this.stats.transactionAttempts++;
      const reads = new Map<string, number>();
      const writes: Array<() => void> = [];
      const tx = {
        get: async (ref: DocRef) => {
          const s = this._store.get(ref.path);
          reads.set(ref.path, s?.version ?? 0);
          const snap = new DocSnapshot(ref.id, ref, s ? s.data : undefined);
          await this.opts.afterTxRead?.(ref.path);
          return snap;
        },
        set: (ref: DocRef, data: Data, o?: { merge?: boolean }) => {
          const frozen = clone(data);
          writes.push(() => this._commitWrite(ref.path, frozen, o?.merge));
        },
        update: (ref: DocRef, data: Data) => {
          const frozen = clone(data);
          writes.push(() => this._commitWrite(ref.path, frozen, true));
        },
        delete: (ref: DocRef) => { writes.push(() => { this._store.delete(ref.path); }); },
      };
      let result: T;
      try {
        result = await fn(tx);
      } catch (e) {
        throw e;
      }
      // ---- atomic commit critical section (synchronous: no awaits) ----
      let conflict = false;
      for (const [path, ver] of reads) {
        if ((this._store.get(path)?.version ?? 0) !== ver) { conflict = true; break; }
      }
      if (conflict) {
        this.stats.transactionAborts++;
        if (attempt >= max) throw new TransactionConflictError();
        continue;
      }
      for (const w of writes) w();
      this.stats.commits++;
      return result;
    }
  }
}
