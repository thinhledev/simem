import assert from "node:assert/strict";
import test from "node:test";
import { toPreview } from "../src/memory/preview.js";
import type { RetrievalHit } from "../src/memory/types.js";

function hit(overrides: Partial<RetrievalHit> = {}): RetrievalHit {
  return {
    source: "memory_item",
    id: 1,
    text: "some text",
    score: 0.5,
    relevance: 0.5,
    recency: 0.5,
    ...overrides,
  };
}

test("toPreview flattens whitespace and leaves short text untouched", () => {
  const preview = toPreview(hit({ text: "line one\n\nline   two" }));
  assert.equal(preview.preview, "line one line two");
  assert.equal(preview.truncated, false);
  assert.equal(preview.source, "memory_item");
  assert.equal(preview.id, 1);
  assert.equal(preview.score, 0.5);
});

test("toPreview truncates long text and sets the flag", () => {
  const long = "a".repeat(500);
  const preview = toPreview(hit({ text: long }), 100);
  assert.equal(preview.preview.length, 100);
  assert.ok(preview.preview.endsWith("…"));
  assert.equal(preview.truncated, true);
});

test("toPreview never includes the raw text field", () => {
  const preview = toPreview(hit({ text: "secret full text" })) as unknown as Record<string, unknown>;
  assert.equal(preview.text, undefined);
});

test("toPreview carries checkpointId only when present", () => {
  const withCheckpoint = toPreview(hit({ checkpointId: "cp-1" }));
  assert.equal(withCheckpoint.checkpointId, "cp-1");
  const withoutCheckpoint = toPreview(hit());
  assert.equal("checkpointId" in withoutCheckpoint, false);
});
