// BERT uncased tokenization (BertNormalizer + BertPreTokenizer + WordPiece),
// matching the Hugging Face `tokenizers` configuration the potion models ship
// with: clean_text, handle_chinese_chars, lowercase (which implies accent
// stripping when strip_accents is null), "##" continuation, 100-char words.

export interface WordPieceOptions {
  vocab: Map<string, number>;
  unkToken?: string;
  continuingPrefix?: string;
  maxInputCharsPerWord?: number;
}

function isControl(char: string): boolean {
  if (char === "\t" || char === "\n" || char === "\r") return false;
  return /\p{Cc}|\p{Cf}/u.test(char);
}

function isWhitespace(char: string): boolean {
  return /\s/u.test(char);
}

function isChineseChar(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2b73f) ||
    (code >= 0x2b740 && code <= 0x2b81f) ||
    (code >= 0x2b820 && code <= 0x2ceaf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x2f800 && code <= 0x2fa1f)
  );
}

// BERT treats all non-alphanumeric ASCII as punctuation, plus Unicode P*.
function isPunctuation(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if ((code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126)) return true;
  return /\p{P}/u.test(char);
}

export function normalize(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0 || code === 0xfffd || isControl(char)) continue;
    if (isWhitespace(char)) out += " ";
    else if (isChineseChar(code)) out += ` ${char} `;
    else out += char;
  }
  // lowercase + strip accents (NFD, drop combining marks)
  return out.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "");
}

export function preTokenize(text: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const char of text) {
    if (isWhitespace(char)) {
      if (current) words.push(current);
      current = "";
    } else if (isPunctuation(char)) {
      if (current) words.push(current);
      words.push(char);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) words.push(current);
  return words;
}

export class WordPieceTokenizer {
  readonly vocab: Map<string, number>;
  readonly unkId: number | undefined;
  private readonly prefix: string;
  private readonly maxChars: number;

  constructor(options: WordPieceOptions) {
    this.vocab = options.vocab;
    this.unkId = this.vocab.get(options.unkToken ?? "[UNK]");
    this.prefix = options.continuingPrefix ?? "##";
    this.maxChars = options.maxInputCharsPerWord ?? 100;
  }

  private wordIds(word: string, out: number[]): void {
    const chars = [...word];
    if (chars.length > this.maxChars) {
      if (this.unkId !== undefined) out.push(this.unkId);
      return;
    }
    const pieces: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        const piece = (start > 0 ? this.prefix : "") + chars.slice(start, end).join("");
        const id = this.vocab.get(piece);
        if (id !== undefined) {
          found = id;
          break;
        }
        end -= 1;
      }
      if (found === undefined) {
        if (this.unkId !== undefined) out.push(this.unkId);
        return;
      }
      pieces.push(found);
      start = end;
    }
    out.push(...pieces);
  }

  /** Token ids without special tokens. */
  encode(text: string, maxTokens = Number.POSITIVE_INFINITY): number[] {
    const ids: number[] = [];
    for (const word of preTokenize(normalize(text))) {
      this.wordIds(word, ids);
      if (ids.length >= maxTokens) return ids.slice(0, maxTokens);
    }
    return ids;
  }
}
