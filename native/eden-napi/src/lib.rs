//! The eden-native tokenizer behind Node-API via napi-rs, to compare Node-API call and string-marshalling costs
//! with bun:ffi and WebAssembly. The JS string arrives as a Rust `String` (napi copies it out as UTF-8).

//!
//! `Uint32Array::as_mut` is unsafe because JS could alias the buffer; these calls are synchronous, so no JS runs
//! while Rust writes to it.

use napi::bindgen_prelude::{Uint32Array, Uint8Array};
use napi_derive::napi;

/// Does nothing: the Node-API call overhead.
#[napi]
pub fn noop() {}

/// Wrapping byte sum, as `eden_sum_bytes`.
#[napi]
pub fn sum_bytes(bytes: Uint8Array) -> u32 {
    bytes.iter().fold(0u32, |acc, &b| acc.wrapping_add(b as u32))
}

/// Tokenize + murmur3 from a JS string (napi marshals it to UTF-8); returns the token count.
#[napi]
pub fn tokenize_hash(text: String, mut out: Uint32Array) -> u32 {
    eden_native::tokenize_hash(&text, unsafe { out.as_mut() }) as u32
}

/// The same from UTF-8 bytes the caller already encoded.
#[napi]
pub fn tokenize_hash_bytes(bytes: Uint8Array, len: u32, mut out: Uint32Array) -> u32 {
    let input = &bytes[..len as usize];
    match std::str::from_utf8(input) {
        Ok(text) => eden_native::tokenize_hash(text, unsafe { out.as_mut() }) as u32,
        Err(_) => eden_native::tokenize_hash(&String::from_utf8_lossy(input), unsafe { out.as_mut() }) as u32,
    }
}
