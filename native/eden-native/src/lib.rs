//! Eden's per-event CPU kernels in Rust, for the language-choice experiment (docs/research/language-choice.md).
//!
//! Everything is exported with a C ABI so the same crate loads through `bun:ffi` (as a cdylib) and as a
//! `wasm32-unknown-unknown` module. Lengths and counts are `u32` so the JS side never sees a BigInt.
//! Inputs are always borrowed caller memory; outputs go to caller-provided buffers and the return value is the
//! number of items produced (which may exceed the buffer's capacity: only `min(count, cap)` are written).

use std::sync::OnceLock;

mod secrets;
mod tokenize;

pub use tokenize::{murmur3_32, tokenize_hash};

/// Builds a byte slice from an FFI pointer, tolerating a null pointer for an empty input.
unsafe fn bytes<'a>(ptr: *const u8, len: u32) -> &'a [u8] {
    if len == 0 || ptr.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len as usize)
    }
}

unsafe fn out_u32<'a>(ptr: *mut u32, cap: u32) -> &'a mut [u32] {
    if cap == 0 || ptr.is_null() {
        &mut []
    } else {
        std::slice::from_raw_parts_mut(ptr, cap as usize)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// 1. FFI overhead probes.

/// Does nothing: the pure cost of crossing the FFI boundary.
#[no_mangle]
pub extern "C" fn eden_noop() {}

/// Wrapping sum of the bytes: the cost of crossing with a pointer + length and touching every byte.
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn eden_sum_bytes(ptr: *const u8, len: u32) -> u32 {
    bytes(ptr, len).iter().fold(0u32, |acc, &b| acc.wrapping_add(b as u32))
}

/// Wrapping sum of UTF-16 code units, the UTF-16 marshalling probe's counterpart of `eden_sum_bytes`.
///
/// # Safety
/// `ptr` must point to `len` readable, aligned u16s.
#[no_mangle]
pub unsafe extern "C" fn eden_sum_u16(ptr: *const u16, len: u32) -> u32 {
    let units: &[u16] = if len == 0 || ptr.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len as usize)
    };
    units.iter().fold(0u32, |acc, &u| acc.wrapping_add(u as u32))
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Tokenize + hash.

/// Tokenizes UTF-8 text (invalid sequences are replaced, as `TextEncoder` never produces them) and writes each
/// token's murmur3 hash to `out`. Returns the token count.
///
/// # Safety
/// `ptr` must point to `len` readable bytes and `out` to `cap` writable u32s.
#[no_mangle]
pub unsafe extern "C" fn eden_tokenize_hash(ptr: *const u8, len: u32, out: *mut u32, cap: u32) -> u32 {
    let input = bytes(ptr, len);
    let out = out_u32(out, cap);
    match std::str::from_utf8(input) {
        Ok(text) => tokenize_hash(text, out) as u32,
        Err(_) => tokenize_hash(&String::from_utf8_lossy(input), out) as u32,
    }
}

/// The same over UTF-16 code units (lone surrogates replaced), so UTF-16 marshalling can be compared end to end.
///
/// # Safety
/// `ptr` must point to `len` readable, aligned u16s and `out` to `cap` writable u32s.
#[no_mangle]
pub unsafe extern "C" fn eden_tokenize_hash_utf16(ptr: *const u16, len: u32, out: *mut u32, cap: u32) -> u32 {
    let units: &[u16] = if len == 0 || ptr.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len as usize)
    };
    let text: String = char::decode_utf16(units.iter().copied())
        .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    tokenize_hash(&text, out_u32(out, cap)) as u32
}

/// murmur3 x86_32 of the bytes, for checking the hash alone against `Bun.hash.murmur32v3`.
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn eden_murmur3(ptr: *const u8, len: u32, seed: u32) -> u32 {
    murmur3_32(bytes(ptr, len), seed)
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Secret scanning over the vendored gitleaks rules.

static SCANNER: OnceLock<secrets::Scanner> = OnceLock::new();

fn scanner() -> &'static secrets::Scanner {
    SCANNER.get_or_init(secrets::Scanner::new)
}

/// Compiles the scanner (idempotent). Returns the number of gitleaks rules it runs.
#[no_mangle]
pub extern "C" fn eden_secrets_init() -> u32 {
    scanner().rules.len() as u32
}

/// Builds the RegexSet used by `eden_secrets_scan_set` (idempotent). Returns 1 when it compiled, else 0.
#[no_mangle]
pub extern "C" fn eden_secrets_set_init() -> u32 {
    scanner().regex_set().is_some() as u32
}

/// Writes rule `index`'s id (UTF-8) to `out`; returns its length.
///
/// # Safety
/// `out` must point to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn eden_secrets_rule_id(index: u32, out: *mut u8, cap: u32) -> u32 {
    let id = scanner()
        .rules
        .get(index as usize)
        .map(|rule| rule.id.as_str())
        .unwrap_or("");
    copy_out(id.as_bytes(), out, cap)
}

/// Writes the compile report (JSON) to `out`; returns its length.
///
/// # Safety
/// `out` must point to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn eden_secrets_report(out: *mut u8, cap: u32) -> u32 {
    copy_out(scanner().report().as_bytes(), out, cap)
}

/// The indices of the gitleaks rules that fire on the text, ascending: the keyword prefilter (Aho-Corasick, ASCII
/// case-insensitive) picks candidate rules, then each candidate's regex, secret group, entropy and allowlists run.
///
/// # Safety
/// `ptr` must point to `len` readable bytes and `out` to `cap` writable u32s.
#[no_mangle]
pub unsafe extern "C" fn eden_secrets_scan(ptr: *const u8, len: u32, out: *mut u32, cap: u32) -> u32 {
    let hits = scanner().scan(bytes(ptr, len), false);
    write_u32s(&hits, out, cap)
}

/// As `eden_secrets_scan`, but every rule's regex first runs as one `RegexSet` over the whole text, and only rules
/// the set and the keyword prefilter both select are verified.
///
/// # Safety
/// `ptr` must point to `len` readable bytes and `out` to `cap` writable u32s.
#[no_mangle]
pub unsafe extern "C" fn eden_secrets_scan_set(ptr: *const u8, len: u32, out: *mut u32, cap: u32) -> u32 {
    let hits = scanner().scan(bytes(ptr, len), true);
    write_u32s(&hits, out, cap)
}

unsafe fn copy_out(src: &[u8], out: *mut u8, cap: u32) -> u32 {
    if !out.is_null() {
        let n = src.len().min(cap as usize);
        std::ptr::copy_nonoverlapping(src.as_ptr(), out, n);
    }
    src.len() as u32
}

unsafe fn write_u32s(src: &[u32], out: *mut u32, cap: u32) -> u32 {
    let out = out_u32(out, cap);
    let n = src.len().min(out.len());
    out[..n].copy_from_slice(&src[..n]);
    src.len() as u32
}

// ---------------------------------------------------------------------------------------------------------------
// WebAssembly has no host allocator the JS side can use, so it asks the module for memory.

/// Allocates `size` bytes (8-byte aligned) that live until `eden_free` is called with the same size.
#[no_mangle]
pub extern "C" fn eden_alloc(size: u32) -> *mut u8 {
    let layout = std::alloc::Layout::from_size_align(size.max(1) as usize, 8).expect("layout");
    unsafe { std::alloc::alloc(layout) }
}

/// Frees memory from `eden_alloc`.
///
/// # Safety
/// `ptr` must come from `eden_alloc(size)` and not have been freed.
#[no_mangle]
pub unsafe extern "C" fn eden_free(ptr: *mut u8, size: u32) {
    let layout = std::alloc::Layout::from_size_align(size.max(1) as usize, 8).expect("layout");
    std::alloc::dealloc(ptr, layout)
}
