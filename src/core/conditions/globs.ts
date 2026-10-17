// Path globs: the one syntax for `paths` in conditions and merge rules, always
// relative to the vault root with `/` separators.
//
// `**` as a whole segment matches any number of directories (none included);
// `*` and `?` match within one segment; `{a,b}` offers alternatives within a
// segment; everything else is literal. Matching errs towards covering more:
// `*` and `**` also match dot-files and `.vault/`, because a merge rule that
// missed a path would let the change escape the rule. Anything the syntax does
// not define is refused rather than guessed at.

const MAX_CACHED = 1000;
const compiled = new Map<string, RegExp>();

type Compiled = { readonly regex: RegExp } | { readonly issue: string };

function literal(text: string): string {
  return [...text]
    .map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
}

function segmentSource(segment: string): string | undefined {
  let source = '';
  for (let i = 0; i < segment.length; ) {
    const ch = segment[i] ?? '';
    if (ch === '{') {
      const close = segment.indexOf('}', i);
      const inner = close === -1 ? '' : segment.slice(i + 1, close);
      if (close === -1 || inner.includes('{')) return undefined;
      source += `(?:${inner.split(',').map(literal).join('|')})`;
      i = close + 1;
    } else if (ch === '}') {
      return undefined;
    } else {
      source += literal(ch);
      i += 1;
    }
  }
  return source;
}

function compile(pattern: string): Compiled {
  if (pattern === '') return { issue: 'must not be empty' };
  if (pattern.startsWith('/')) return { issue: 'must be relative to the vault root' };
  if (pattern.includes('\\')) return { issue: 'must use / as the separator' };
  if (/[[\]]/.test(pattern)) return { issue: 'character classes are not supported' };
  const segments = pattern.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return { issue: 'must not contain empty, . or .. segments' };
  let source = '';
  for (const [i, segment] of segments.entries()) {
    const last = i === segments.length - 1;
    if (segment === '**') {
      source += last ? '.*' : '(?:[^/]*/)*';
      continue;
    }
    const part = segmentSource(segment);
    if (part === undefined) return { issue: 'braces must be closed, within one segment, and not nested' };
    source += last ? part : `${part}/`;
  }
  // `s`: a file name may contain a line break, and `.*` must still cover it.
  return { regex: new RegExp(`^${source}$`, 's') };
}

/** Why `pattern` is not a valid glob, or undefined when it is. */
export function globIssue(pattern: string): string | undefined {
  const result = compile(pattern);
  return 'issue' in result ? result.issue : undefined;
}

/**
 * Whether `path` matches `pattern`. Patterns are validated when the document
 * that holds them is parsed, so an invalid one here is a programming error.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  let regex = compiled.get(pattern);
  if (regex === undefined) {
    const result = compile(pattern);
    if ('issue' in result) throw new Error(`invalid glob reached matching: ${result.issue}`);
    if (compiled.size >= MAX_CACHED) compiled.clear();
    regex = result.regex;
    compiled.set(pattern, regex);
  }
  return regex.test(path);
}
