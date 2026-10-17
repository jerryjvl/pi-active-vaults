// Canonical JSON: object keys sorted at every level, so equal data always
// gives the same text however it was built — for hashes that version a
// definition, and for data handed to a script or a job.

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}
