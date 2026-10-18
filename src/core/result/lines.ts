// JSON-lines framing, shared by everything that talks in lines (a child's
// standard output, the daemon's socket): a byte stream split on line feeds
// only, a trailing carriage return dropped. Other Unicode line separators may
// appear inside a JSON string, so they never split a line. A line longer than
// the limit is dropped whole rather than held, so a misbehaving peer cannot
// exhaust memory.

export interface LineSplitter {
  push(chunk: Buffer): void;
  /** The last line, if the stream ended without a line feed. */
  end(): void;
}

export function lineSplitter(maxLineBytes: number, emit: (line: string) => void): LineSplitter {
  let pending: Buffer[] = [];
  let size = 0;
  let overlong = false;
  const flush = (last: Buffer): void => {
    if (!overlong && size + last.length <= maxLineBytes) {
      let line = Buffer.concat([...pending, last]);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      emit(line.toString('utf8'));
    }
    pending = [];
    size = 0;
    overlong = false;
  };
  return {
    push(chunk) {
      let start = 0;
      for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, start)) {
        flush(chunk.subarray(start, at));
        start = at + 1;
      }
      const rest = chunk.subarray(start);
      if (rest.length === 0 || overlong) return;
      size += rest.length;
      if (size > maxLineBytes) {
        overlong = true;
        pending = [];
      } else {
        pending.push(rest);
      }
    },
    end() {
      if (size > 0 || overlong) flush(Buffer.alloc(0));
    },
  };
}
