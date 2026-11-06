/**
 * D1-compatible shim over Node's built-in SQLite (node:sqlite), running the real migrations.
 * Supports prepare/bind/run/first/all and transactional batch().
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Value = string | number | bigint | null | Uint8Array;

class Stmt {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: Value[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params.map((p) => (p === undefined ? null : (p as Value))));
  }
  private prep(): StatementSync {
    return this.db.prepare(this.sql);
  }
  async run() {
    const s = this.prep();
    if (/\bRETURNING\b/i.test(this.sql)) {
      const results = s.all(...this.params);
      return { success: true, results, meta: { changes: results.length } };
    }
    const r = s.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first<T>(): Promise<T | null> {
    return ((this.prep().get(...this.params) as T | undefined) ?? null) as T | null;
  }
  async all<T>() {
    return { success: true, results: this.prep().all(...this.params) as T[], meta: {} };
  }
  runSync() {
    return this.run();
  }
}

export class FakeD1 {
  db = new DatabaseSync(":memory:");
  constructor(migrationDir: string) {
    const dir = join(__dirname, "../../migrations", migrationDir);
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) this.db.exec(readFileSync(join(dir, f), "utf8"));
  }
  prepare(sql: string) {
    return new Stmt(this.db, sql);
  }
  async batch(stmts: Stmt[]) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
}

export class FakeKV {
  store = new Map<string, string>();
  async get(key: string, opts?: { type?: string } | string) {
    const v = this.store.get(key);
    if (v === undefined) return null;
    const type = typeof opts === "string" ? opts : opts?.type;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
}

export class FakeQueue<T> {
  sent: T[] = [];
  async send(body: T) {
    this.sent.push(body);
  }
  async sendBatch(msgs: Array<{ body: T }>) {
    for (const m of msgs) this.sent.push(m.body);
  }
}
