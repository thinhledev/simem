import { isInternalMemoryPrompt } from "../internal-prompt.js";
import { queryTerms } from "../retrieval.js";
import { capText, oneLine } from "../text-cap.js";
import type { ConsolidationItem, ConsolidationOutput, MemoryCategory, MemoryKind } from "../types.js";

// Tier 0 distillation: deterministic, zero-token extraction of the user's
// durable statements plus a template summary. Only USER sentences become
// items — an assistant's claims are not decisions — and the assistant's last
// message only feeds the summary's outcome line.

export interface RuleMessage {
  role: string;
  text: string;
}

interface Rule {
  category: MemoryCategory;
  kind: MemoryKind;
  importance: number;
  pattern: RegExp;
}

// Ordered: the first matching rule decides a sentence's category.
const RULES: Rule[] = [
  {
    category: "constraint",
    kind: "semantic",
    importance: 8,
    pattern:
      /\b(never|must|mustn't|do not|don't|not allowed|forbidden|required|always|make sure|ensure|shouldn't|should not|avoid)\b/i,
  },
  {
    category: "preference",
    kind: "semantic",
    importance: 7,
    pattern:
      /\b(i prefer|i'd prefer|i would prefer|prefer to|i like|i'd like|i would like|i want|i'd rather|i would rather|please use|please keep|keep it)\b/i,
  },
  {
    category: "decision",
    kind: "semantic",
    importance: 7,
    pattern:
      /\b(we decided|i decided|decided to|we'll go with|go with|we will use|we'll use|let's (use|go with|switch|keep|drop|remove|stick with|adopt|move to|rename|deprecate|replace)|stick with|from now on|going forward)\b|\b(use|using|go with|prefer|choose|keep|adopt|pick)\b.*\b(instead of|rather than)\b/i,
  },
  {
    category: "todo",
    kind: "episodic",
    importance: 5,
    pattern: /\b(todo|to-do|follow[- ]up|remind me|don't forget|still need to|later we|we need to .* later|next phase|next step)\b/i,
  },
];

// Phrases that contain a rule keyword but state no rule: hedges, feelings,
// and questions about the agent's own understanding.
const FALSE_POSITIVES = [
  /\b(don't|do not|can't|cannot) (know|think|understand|see|remember|find|tell|recall|believe)\b/i,
  /\bdon't (worry|mean)\b/i,
  // A one-off task request, not a standing preference.
  /\bi (want|would like|'d like) to (proceed|continue|start|do|fix|add|implement|build|make|check|see|try|go|move|work|ask|update|create|run|test|review)\b/i,
  /\b(i'd like|i would like|i want) (you )?to (know|see|understand|ask)\b/i,
  /\bmake sure (that )?(you|it) (understand|know)\b/i,
];

// A user correcting the previous assistant turn: the rest of the message is
// the corrected instruction, which outranks a plain preference.
const CORRECTION_LEAD = /^(no|nope|wrong|actually|wait|not quite|that's not|that is not|that's wrong|instead)\b[\s,.!:-]*/i;

const MAX_ITEMS_PER_CHECKPOINT = 12;
const MIN_SENTENCE_CHARS = 12;
const MAX_SENTENCE_CHARS = 300;
// Long user messages are usually pasted logs, docs, or code; instructions sit
// at the start and end, so only those parts are mined.
const PASTE_THRESHOLD_CHARS = 2_500;
const PASTE_EDGE_CHARS = 700;

function minableText(text: string): string {
  const withoutCode = text.replaceAll(/```[\s\S]*?```/g, " ");
  if (withoutCode.length <= PASTE_THRESHOLD_CHARS) return withoutCode;
  // Cut on line boundaries so no half-line fragment becomes a "sentence".
  const head = withoutCode.slice(0, PASTE_EDGE_CHARS);
  const tail = withoutCode.slice(-PASTE_EDGE_CHARS);
  return `${head.slice(0, Math.max(0, head.lastIndexOf("\n")))}\n${tail.slice(tail.indexOf("\n") + 1)}`;
}

function isProseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Indented code, quotes, tables, shell prompts, markdown headings, tags.
  if (/^(\s{4,}|\t|>|\||\$ |#|<\/?[a-z-]+>)/i.test(line)) return false;
  // Log/stack-trace/data lines: mostly symbols and digits.
  const letters = trimmed.replaceAll(/[^\p{L}]/gu, "").length;
  return letters / trimmed.length >= 0.55;
}

export function splitSentences(text: string): string[] {
  return minableText(text)
    .split(/\r?\n/)
    .filter(isProseLine)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""))
    .flatMap((line) => line.split(/(?<=[.!?;])\s+(?=[A-Z`"'(])/))
    .map((sentence) => oneLine(sentence))
    .filter((sentence) => sentence.length >= MIN_SENTENCE_CHARS && sentence.length <= MAX_SENTENCE_CHARS);
}

function cleanSentence(sentence: string): string {
  const stripped = sentence.replace(/^(ok(ay)?|so|also|and|but|then|now|btw|note)[,:]?\s+/i, "").trim();
  const capitalized = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  return /[.!]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function classify(sentence: string): Rule | undefined {
  // Questions ask; a trailing colon introduces a list rather than stating anything.
  if (/[?:]$/.test(sentence.trim())) return undefined;
  if (FALSE_POSITIVES.some((pattern) => pattern.test(sentence))) return undefined;
  // A rule needs a topic: "don't do that." names nothing a later session can use.
  if (queryTerms(sentence).length < 2) return undefined;
  return RULES.find((rule) => rule.pattern.test(sentence));
}

function isHumanMessage(message: RuleMessage): boolean {
  return message.role === "user" && !isInternalMemoryPrompt(message.text);
}

export function extractRuleItems(messages: RuleMessage[]): ConsolidationItem[] {
  const items: ConsolidationItem[] = [];
  const seen = new Set<string>();
  messages.forEach((message, index) => {
    if (!isHumanMessage(message)) return;
    const correcting = index > 0 && messages[index - 1]?.role === "assistant" && CORRECTION_LEAD.test(message.text.trim());
    const body = correcting ? message.text.trim().replace(CORRECTION_LEAD, "") : message.text;
    splitSentences(body).forEach((sentence, sentenceIndex) => {
      const rule = classify(sentence);
      // The first sentence of a correction counts even without a rule keyword
      // ("No, use pnpm."); it still needs a topic.
      const asCorrection = correcting && sentenceIndex === 0 && queryTerms(sentence).length >= 2 && !sentence.endsWith("?");
      if (!rule && !asCorrection) return;
      const text = cleanSentence(sentence);
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      items.push(
        asCorrection
          ? { kind: "semantic", category: rule?.category === "constraint" ? "constraint" : "preference", text, importance: 8 }
          : { kind: rule!.kind, category: rule!.category, text, importance: rule!.importance },
      );
    });
  });
  // Keep the most important statements when a long session yields many.
  return items
    .map((item, order) => ({ item, order }))
    .sort((left, right) => right.item.importance - left.item.importance || left.order - right.order)
    .slice(0, MAX_ITEMS_PER_CHECKPOINT)
    .sort((left, right) => left.order - right.order)
    .map(({ item }) => item);
}

const PATH_PATTERN = /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|rb|java|kt|swift|cs|c|cc|cpp|h|css|scss|html|yml|yaml|toml|sql|sh))(?=[\s`'"):,]|\.(?:\s|$)|$)/g;
const MAX_FILES = 8;
const MILESTONE_PATTERN =
  /\b(shipped|released|published|merged|implemented|is fixed|now fixed|all \d+ (?:tests )?pass|tests? (?:all )?pass(?:ed)?|completed)\b/i;

function filesMentioned(messages: RuleMessage[]): string[] {
  const files: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const match of message.text.matchAll(PATH_PATTERN)) {
      const path = match[1];
      if (path && !files.includes(path)) files.push(path);
      if (files.length === MAX_FILES) return files;
    }
  }
  return files;
}

function firstSentences(text: string, maxChars: number): string {
  const sentences = splitSentences(text);
  const joined = sentences.length > 0 ? sentences.slice(0, 2).join(" ") : oneLine(text);
  return capText(joined, maxChars).text;
}

// Template summary: what was asked, what came of it, and which files it
// touched — the same shape for every checkpoint, so it rolls up cleanly.
export function ruleSummary(messages: RuleMessage[]): { summary: string; milestone: boolean } {
  const asks = messages.filter((message) => isHumanMessage(message) && queryTerms(message.text).length >= 2);
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const lines: string[] = [];
  const first = asks[0];
  const last = asks.at(-1);
  if (first) lines.push(`Objective: ${firstSentences(first.text, 300)}`);
  if (last && last !== first) lines.push(`Latest request: ${firstSentences(last.text, 300)}`);
  if (lastAssistant) lines.push(`Outcome: ${firstSentences(lastAssistant.text, 400)}`);
  const files = filesMentioned(messages);
  if (files.length > 0) lines.push(`Files: ${files.join(", ")}`);
  return {
    summary: lines.join("\n") || "No user objective was captured in this checkpoint.",
    milestone: Boolean(lastAssistant && MILESTONE_PATTERN.test(lastAssistant.text)),
  };
}

export function distillWithRules(messages: RuleMessage[]): ConsolidationOutput {
  const { summary, milestone } = ruleSummary(messages);
  return { summary, milestone, items: extractRuleItems(messages) };
}
