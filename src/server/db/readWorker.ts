/**
 * Read-only SQLite connection in a worker thread (see readers.ts). Runs the statements it gets and
 * keeps the prepared ones for reuse.
 */
import { parentPort, workerData } from 'node:worker_threads';
import BetterSqlite3 from 'better-sqlite3';

const { file } = workerData as { file: string };
const db = new BetterSqlite3(file, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
db.pragma('cache_size = -65536');
db.pragma('mmap_size = 268435456');
db.pragma('query_only = ON');

const statements = new Map<string, BetterSqlite3.Statement>();
function statement(sql: string): BetterSqlite3.Statement {
  let st = statements.get(sql);
  if (!st) {
    st = db.prepare(sql);
    if (statements.size > 300) statements.delete(statements.keys().next().value!);
    statements.set(sql, st);
  }
  return st;
}

parentPort?.on('message', (msg: { id: number; op: 'all' | 'get'; sql: string; params: unknown[] }) => {
  try {
    const st = statement(msg.sql);
    const result = msg.op === 'all' ? st.all(...msg.params) : st.get(...msg.params);
    parentPort!.postMessage({ id: msg.id, result });
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});
