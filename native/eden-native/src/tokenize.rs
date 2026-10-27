//! The experiment's tokenizer, which must match `native/bench/lib/tokenize.ts` exactly:
//!
//! - a token starts at a letter or digit (`char::is_alphabetic`, i.e. Unicode `Alphabetic`, or `char::is_numeric`,
//!   i.e. general category N) and continues while the char is a letter, digit, `'`, `_` or `-`;
//! - it is lowercased (`str::to_lowercase`, which like JavaScript's `toLowerCase` handles final sigma);
//! - a trailing `'s` is stripped, and a token of at most one char is dropped;
//! - each kept token yields murmur3 x86_32 (seed 0) of its UTF-8 bytes.

/// Byte classes for ASCII: 1 = may start a token (letter or digit), 2 = may only continue one (`'`, `_`, `-`).
const ASCII_CLASS: [u8; 128] = {
    let mut table = [0u8; 128];
    let mut c = 0;
    while c < 128 {
        let b = c as u8;
        if b.is_ascii_alphanumeric() {
            table[c] = 1;
        } else if b == b'\'' || b == b'_' || b == b'-' {
            table[c] = 2;
        }
        c += 1;
    }
    table
};

#[inline]
fn is_word(ch: char) -> bool {
    ch.is_alphabetic() || ch.is_numeric()
}

/// Tokenizes `text`, writing hashes to `out` while it has room; returns the token count.
pub fn tokenize_hash(text: &str, out: &mut [u32]) -> usize {
    let b = text.as_bytes();
    let n = b.len();
    let mut i = 0;
    let mut count = 0;
    // Reused across non-ASCII tokens so lowercasing does not allocate per token.
    let mut lower = String::with_capacity(64);
    while i < n {
        let c = b[i];
        if c < 0x80 {
            if ASCII_CLASS[c as usize] != 1 {
                i += 1;
                continue;
            }
        } else {
            // Safe: `i` is always on a char boundary, since we only ever advance by whole chars.
            let ch = text[i..].chars().next().unwrap();
            if !is_word(ch) {
                i += ch.len_utf8();
                continue;
            }
        }
        let start = i;
        let mut ascii = true;
        while i < n {
            let c = b[i];
            if c < 0x80 {
                if ASCII_CLASS[c as usize] == 0 {
                    break;
                }
                i += 1;
            } else {
                let ch = text[i..].chars().next().unwrap();
                if !is_word(ch) {
                    break;
                }
                ascii = false;
                i += ch.len_utf8();
            }
        }
        let hash = if ascii {
            let mut end = i;
            if end - start >= 2 && b[end - 2] == b'\'' && (b[end - 1] | 0x20) == b's' {
                end -= 2;
            }
            if end - start <= 1 {
                continue;
            }
            murmur3_32_ascii_lower(&b[start..end])
        } else {
            let raw = &text[start..i];
            lower.clear();
            if raw.contains('Σ') {
                // Final sigma is the only context-dependent lowercase mapping; leave it to `str::to_lowercase`.
                lower.push_str(&raw.to_lowercase());
            } else {
                lower.extend(raw.chars().flat_map(char::to_lowercase));
            }
            let token = lower.strip_suffix("'s").unwrap_or(&lower);
            if token.chars().nth(1).is_none() {
                continue;
            }
            murmur3_32(token.as_bytes(), 0)
        };
        if count < out.len() {
            out[count] = hash;
        }
        count += 1;
    }
    count
}

/// murmur3 x86_32 (seed 0) of ASCII bytes lowercased on the fly, without copying them.
fn murmur3_32_ascii_lower(data: &[u8]) -> u32 {
    const LOWER: u32 = 0x2020_2020;
    let mut h = 0u32;
    let mut chunks = data.chunks_exact(4);
    for chunk in &mut chunks {
        let raw = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        // Per byte: set bit 5 only where the byte is in 'A'..='Z' (SWAR range check, valid for ASCII bytes).
        let ge_a = raw.wrapping_add(0x3f3f_3f3f) & 0x8080_8080 & !raw.wrapping_add(0x2525_2525);
        let k = raw | ((ge_a >> 2) & LOWER);
        h = mix_h(h, k);
    }
    let tail = chunks.remainder();
    if !tail.is_empty() {
        let mut k = 0u32;
        for (shift, &byte) in tail.iter().enumerate() {
            k |= (byte.to_ascii_lowercase() as u32) << (8 * shift);
        }
        h ^= mix_k(k);
    }
    finish(h, data.len())
}

#[inline]
fn mix_k(k: u32) -> u32 {
    k.wrapping_mul(0xcc9e_2d51).rotate_left(15).wrapping_mul(0x1b87_3593)
}

#[inline]
fn mix_h(h: u32, k: u32) -> u32 {
    (h ^ mix_k(k)).rotate_left(13).wrapping_mul(5).wrapping_add(0xe654_6b64)
}

#[inline]
fn finish(mut h: u32, len: usize) -> u32 {
    h ^= len as u32;
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^ (h >> 16)
}

/// murmur3 x86_32.
pub fn murmur3_32(data: &[u8], seed: u32) -> u32 {
    const C1: u32 = 0xcc9e_2d51;
    const C2: u32 = 0x1b87_3593;
    let mut h = seed;
    let mut chunks = data.chunks_exact(4);
    for chunk in &mut chunks {
        let mut k = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        k = k.wrapping_mul(C1).rotate_left(15).wrapping_mul(C2);
        h ^= k;
        h = h.rotate_left(13).wrapping_mul(5).wrapping_add(0xe654_6b64);
    }
    let tail = chunks.remainder();
    if !tail.is_empty() {
        let mut k = 0u32;
        for (shift, &byte) in tail.iter().enumerate() {
            k |= (byte as u32) << (8 * shift);
        }
        k = k.wrapping_mul(C1).rotate_left(15).wrapping_mul(C2);
        h ^= k;
    }
    h ^= data.len() as u32;
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn murmur_known_vectors() {
        assert_eq!(murmur3_32(b"", 0), 0);
        assert_eq!(murmur3_32(b"hello", 0), 0x248b_fa47);
        assert_eq!(
            murmur3_32(b"The quick brown fox jumps over the lazy dog", 0),
            0x2e4f_f723
        );
    }

    #[test]
    fn ascii_lower_hash_equals_hash_of_lowercased() {
        let all: Vec<u8> = (0u8..128).collect();
        for start in 0..all.len() {
            for len in 0..9.min(all.len() - start) {
                let slice = &all[start..start + len];
                assert_eq!(
                    murmur3_32_ascii_lower(slice),
                    murmur3_32(&slice.to_ascii_lowercase(), 0)
                );
            }
        }
    }

    #[test]
    fn tokens() {
        let mut out = [0u32; 16];
        let n = tokenize_hash("Dana's OPS-142 a it's Zoë 東京 x", &mut out);
        let expect: Vec<u32> = ["dana", "ops-142", "it", "zoë", "東京"]
            .iter()
            .map(|t| murmur3_32(t.as_bytes(), 0))
            .collect();
        // "it's" -> "it" (2 chars, kept); "a" and "x" are dropped.
        assert_eq!(&out[..n], &expect[..]);
    }
}
