/**
 * テスト用の最小 D1 互換シム。node:sqlite のインメモリ DB に migrations/ を流し込み、
 * repository の生 SQL を本物の SQLite で検証する（Workers ランタイムは不要）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    const params = values.map((v) =>
      v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as SQLInputValue),
    );
    return new Statement(this.db, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const result = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(result.changes) } };
  }
}

export function createTestD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const dir = join(import.meta.dirname, '..', '..', 'migrations');
  for (const file of readdirSync(dir).sort()) {
    db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  const shim = {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (statements: Statement[]) => Promise.all(statements.map((s) => s.run())),
  };
  return shim as unknown as D1Database;
}
