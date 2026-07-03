import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { cosineSimilarity, detectOllama, fromBlob, toBlob } from "../src/memory/embeddings.js";

async function startFakeOllama(handler: (path: string, body: unknown) => unknown): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as unknown) : undefined;
      const result = handler(req.url ?? "", body);
      if (result === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  return { url: `http://127.0.0.1:${address.port}`, server };
}

test("returns undefined when the connection is refused", async () => {
  const client = await detectOllama("http://127.0.0.1:1", "nomic-embed-text");
  assert.equal(client, undefined);
});

test("returns undefined when the request times out", async () => {
  const server = createServer(() => {
    // Never respond, forcing the client's own timeout to fire.
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  try {
    const client = await detectOllama(`http://127.0.0.1:${address.port}`, "nomic-embed-text", 50);
    assert.equal(client, undefined);
  } finally {
    server.close();
  }
});

test("returns undefined when the configured model is not installed", async () => {
  const { url, server } = await startFakeOllama((path) => {
    if (path === "/api/tags") return { models: [{ name: "llama3:latest" }] };
    return undefined;
  });
  try {
    const client = await detectOllama(url, "nomic-embed-text");
    assert.equal(client, undefined);
  } finally {
    server.close();
  }
});

test("builds a working embedding client against a real HTTP server", async () => {
  const { url, server } = await startFakeOllama((path, body) => {
    if (path === "/api/tags") return { models: [{ name: "nomic-embed-text:latest" }] };
    if (path === "/api/embed") {
      const inputs = (body as { input: string[] }).input;
      return { embeddings: inputs.map((text) => [text.length, text.length / 2, 1]) };
    }
    return undefined;
  });
  try {
    const client = await detectOllama(url, "nomic-embed-text");
    assert.ok(client);
    assert.equal(client.model, "nomic-embed-text");
    assert.equal(client.dim, 3);
    const [vector] = await client.embed(["hello"]);
    assert.deepEqual(Array.from(vector ?? []), [5, 2.5, 1]);
  } finally {
    server.close();
  }
});

test("blob round-trip and cosine similarity are consistent", () => {
  const vector = Float32Array.from([1, 2, 3]);
  const blob = toBlob(vector);
  const restored = fromBlob(blob);
  assert.deepEqual(Array.from(restored), Array.from(vector));
  assert.ok(cosineSimilarity(vector, restored) > 0.999);
  assert.equal(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0);
});
