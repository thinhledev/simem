import type { DatabaseSync } from "node:sqlite";

export interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSync;
}

let cachedSqlite: SqliteModule | null | undefined;

const SQLITE_EXPERIMENTAL_WARNING_SNIPPET = "SQLite is an experimental feature";

// node:sqlite unconditionally emits a process-wide ExperimentalWarning the
// first time it's imported, with no stable alternative to switch to — every
// `simem` invocation would otherwise print it on every run. Suppress only this
// exact warning (never warnings in general) by intercepting process.emitWarning
// for the duration of the import. Synchronous (require of a builtin) so path
// resolution — which needs the project registry — can stay synchronous.
export function loadSqliteSync(): SqliteModule | undefined {
  if (cachedSqlite !== undefined) return cachedSqlite ?? undefined;
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (message.includes(SQLITE_EXPERIMENTAL_WARNING_SNIPPET)) return;
    return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    // getBuiltinModule loads builtins synchronously from ESM, CommonJS, and
    // single-executable builds alike.
    cachedSqlite = (process.getBuiltinModule("node:sqlite") as SqliteModule | undefined) ?? null;
  } catch {
    cachedSqlite = null;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  return cachedSqlite ?? undefined;
}

export async function loadSqlite(): Promise<SqliteModule | undefined> {
  return loadSqliteSync();
}
