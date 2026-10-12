import assert from "node:assert/strict";
import test from "node:test";
import { sanitize } from "../src/memory/sanitize.js";

test("redacts common credential formats and counts each kind", () => {
  const input = [
    "ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    "export OPENAI_API_KEY='sk-proj-abcdefghijklmnopqrstuvwxyz123456'",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "aws AKIAIOSFODNN7EXAMPLE",
    "postgres://admin:hunter2secret@db.internal:5432/app",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const { text, redactions } = sanitize(input);
  for (const secret of ["AbCdEfGhIjKlMnOp", "abcdefghijklmnopqrstuvwxyz123456", "ghp_abcdefghij", "AKIAIOSFODNN7EXAMPLE", "hunter2secret", "dozjgNryP4J3", "MIIEow"]) {
    assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
  }
  assert.match(text, /postgres:\/\/admin:\[REDACTED\]@db\.internal/);
  assert.ok((redactions["private-key"] ?? 0) === 1);
  assert.ok(Object.values(redactions).reduce((a, b) => a + b, 0) >= 7);
});

test("leaves ordinary prose and code alone", () => {
  const input = "Use the token bucket in src/rate-limit.ts; the PASSWORD field is validated by zod. const apiKey = config.apiKey;";
  assert.deepEqual(sanitize(input), { text: input, redactions: {} });
});
