// Time-sortable unique IDs (trace IDs), ULID-shaped: 10 characters of
// millisecond time then 16 of randomness, Crockford base32, upper case only so
// the ID is safe in file names on case-insensitive filesystems.
//
// Invariants: IDs from one source are strictly increasing — within a
// millisecond the random part is incremented, and a clock stepping backwards
// is ignored — so "sorted by ID" is "sorted by issue order". Time and randomness
// are both injected.

import type { Clock } from '../clock/index.ts';

export interface IdSource {
  next(): string;
}

/** Returns exactly `length` random bytes. */
export type RandomBytes = (length: number) => Uint8Array;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10; // 80 bits = 16 base32 characters
const RANDOM_LIMIT = 1n << 80n;
const ID_PATTERN = new RegExp(`^[${ALPHABET}]{${TIME_CHARS + RANDOM_CHARS}}$`);

function encode(value: bigint, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

function decode(text: string): bigint {
  let value = 0n;
  for (const ch of text) value = (value << 5n) | BigInt(ALPHABET.indexOf(ch));
  return value;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

export function createIdSource(deps: { clock: Clock; randomBytes: RandomBytes }): IdSource {
  let lastTime = -1;
  let lastRandom = 0n;
  return {
    next() {
      const now = deps.clock.now().getTime();
      if (now > lastTime) {
        const bytes = deps.randomBytes(RANDOM_BYTES);
        if (bytes.length !== RANDOM_BYTES) {
          throw new Error(`randomBytes returned ${bytes.length} bytes, expected ${RANDOM_BYTES}`);
        }
        lastTime = now;
        lastRandom = bytesToBigInt(bytes);
      } else {
        // Same millisecond, or the clock stepped back: keep the timestamp and
        // count up so ordering holds.
        lastRandom += 1n;
        if (lastRandom >= RANDOM_LIMIT) throw new Error('ID randomness exhausted within one millisecond');
      }
      return encode(BigInt(lastTime), TIME_CHARS) + encode(lastRandom, RANDOM_CHARS);
    },
  };
}

export function isTraceId(text: string): boolean {
  return ID_PATTERN.test(text);
}

/** When the ID was issued, or undefined if it is not a well-formed ID (never guesses). */
export function traceIdTime(id: string): Date | undefined {
  if (!isTraceId(id)) return undefined;
  const ms = Number(decode(id.slice(0, TIME_CHARS)));
  return Number.isSafeInteger(ms) ? new Date(ms) : undefined;
}
