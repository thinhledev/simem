import { existsSync, unlinkSync } from "node:fs";
import type { GatewayConfig } from "../config.js";
import { codeIndexPath, metaGet, openCodeIndex } from "../codeindex/db.js";
import { codeSearch, ensureIndexed } from "../codeindex/search.js";
import { resolveEmbeddings } from "../vec/client.js";
import { displayPath, print, type Output } from "./common.js";

export async function runIndex(options: Output & { cwd: string; config: GatewayConfig; status: boolean; rebuild: boolean; query?: string }): Promise<void> {
  if (options.status) {
    const index = openCodeIndex(options.cwd);
    if (!index) throw new Error("The code index needs node:sqlite (Node.js >= 22.5)");
    try {
      const count = (sql: string) => (index.db.prepare(sql).get() as { n: number }).n;
      const status = {
        path: index.path,
        files: count("SELECT COUNT(*) AS n FROM files"),
        symbols: count("SELECT COUNT(*) AS n FROM symbols"),
        chunks: count("SELECT COUNT(*) AS n FROM chunks"),
        embedded: count("SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL"),
        indexedAt: metaGet(index, "indexed_at") ?? null,
      };
      print(options, `Code index ${displayPath(status.path)}: ${status.files} files, ${status.symbols} symbols, ${status.chunks} chunks (${status.embedded} with vectors), updated ${status.indexedAt ?? "never"}`, status);
    } finally {
      index.close();
    }
    return;
  }
  if (options.rebuild) {
    const { path } = codeIndexPath(options.cwd);
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${path}${suffix}`)) unlinkSync(`${path}${suffix}`);
  }
  const ready = await ensureIndexed(options.cwd, options.config.memory, { force: true });
  if (!ready) throw new Error("The code index needs node:sqlite (Node.js >= 22.5)");
  try {
    if (options.query) {
      const embeddings = await resolveEmbeddings(options.config.memory);
      const hits = await codeSearch(ready.index, options.query, { ...(embeddings ? { embeddings } : {}) });
      print(options, hits.map((hit) => `${hit.path}:${hit.start}-${hit.end}  ${hit.kind} ${hit.name}  ${hit.signature}`).join("\n") || "No matches.", hits);
      return;
    }
    const stats = ready.stats;
    print(
      options,
      stats
        ? `Indexed ${stats.files} files (${stats.changed} changed, ${stats.removed} removed): ${stats.symbols} symbols, ${stats.chunks} chunks, ${stats.embedded} embedded in ${stats.ms} ms.`
        : "Index is up to date.",
      stats ?? {},
    );
  } finally {
    ready.index.close();
  }
}
