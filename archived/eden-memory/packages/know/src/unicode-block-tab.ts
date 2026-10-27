/** Unicode block names. Codec; ranges live in synth UNICODE_BLOCK_BLOB. */
export const UNICODE_BLOCK_TAB = `Arabic
Basic Latin
CJK Unified Ideographs
Cyrillic
Hangul Syllables
Hiragana
Katakana
Latin-1 Supplement
Private Use Area`;

export function unicodeBlockNames(): string[] {
  return UNICODE_BLOCK_TAB.split("\n").filter(Boolean);
}
