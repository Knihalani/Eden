/**
 * The bytes of a line not yet ended, held between reads (the SSE parser's and the stdio transport's). A peer that
 * sends a line a byte at a time hands over one tiny read after another; each kept as its own array cost about 150
 * bytes of object for every byte held (3 MB dripped in 1-byte writes held 798k arrays and +119 MB of RSS over stdio,
 * +172 MB over SSE: D1860's review). So past the first `FEW` reads a small piece is copied into one buffer that doubles
 * as it fills (amortized one copy a byte), and only a piece of `MIN_VIEW` bytes or more is kept as its own array (a
 * view of the read when the caller never changes its reads, else a copy): the arrays held are at most `FEW` plus twice
 * the bytes over `MIN_VIEW`, a few hundred at the 4 MiB cap, and the bytes held at most about twice the line. The line
 * is joined once, at its end.
 */

/** A piece at least this long is kept as it is; a shorter one, past the first `FEW`, is copied into the buffer. */
const MIN_VIEW = 16 * 1024;
const MIN_BUFFER = 256;
/** Small reads held as their own arrays before the rest are copied into the shared buffer. */
const FEW = 8;

export class Pieces {
  /** Total bytes held. */
  bytes = 0;
  private parts: Uint8Array[] = [];
  /** The buffer small pieces are copied into, and how much of it is used. */
  private buf: Uint8Array | null = null;
  private used = 0;

  /**
   * Holds `piece`. `kept`: the caller never changes it after this call, so a long piece is held as a view.
   * `max` bounds the shared buffer's growth (the caller has already checked `bytes + piece.length` against it).
   */
  add(piece: Uint8Array, kept: boolean, max: number): void {
    this.bytes += piece.length;
    // A line over a few reads (the common case: a large event across Bun's 64-256 KB reads) is held as before, one
    // array a read; only past `FEW` small reads does copying start. Copying from the first small read cost 7-23% of
    // the CPU of a 64 KB SSE call.
    if (piece.length >= MIN_VIEW || (this.used === 0 && this.parts.length < FEW)) {
      this.seal();
      this.parts.push(kept ? piece : piece.slice());
      return;
    }
    const need = this.used + piece.length;
    if (!this.buf || need > this.buf.length) {
      const grown = new Uint8Array(Math.max(need, Math.min(max, Math.max(MIN_BUFFER, (this.buf?.length ?? 0) * 2))));
      if (this.buf) grown.set(this.buf.subarray(0, this.used));
      this.buf = grown;
    }
    this.buf.set(piece, this.used);
    this.used = need;
  }

  /**
   * The held bytes followed by `last`, in one array the caller owns (no other holder sees it), and the holder emptied.
   * Copied once; when only the shared buffer is held and `last` fits after it, it is filled in place instead.
   */
  take(last: Uint8Array): Uint8Array {
    let out: Uint8Array;
    if (this.parts.length === 0 && this.buf && this.used + last.length <= this.buf.length) {
      this.buf.set(last, this.used);
      out = this.buf.subarray(0, this.used + last.length);
    } else {
      this.seal();
      out = new Uint8Array(this.bytes + last.length);
      let at = 0;
      for (const p of this.parts) {
        out.set(p, at);
        at += p.length;
      }
      out.set(last, at);
    }
    this.clear();
    return out;
  }

  clear(): void {
    this.parts = [];
    this.buf = null;
    this.used = 0;
    this.bytes = 0;
  }

  /** Arrays held, for the tests that bound them. */
  get count(): number {
    return this.parts.length + (this.used > 0 ? 1 : 0);
  }

  /** Ends the shared buffer: what it holds becomes a part, and the next small piece starts a new one. */
  private seal(): void {
    if (this.used === 0) return;
    this.parts.push(this.buf!.subarray(0, this.used));
    this.buf = null;
    this.used = 0;
  }
}
