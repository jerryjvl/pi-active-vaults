// The standard keys a document's frontmatter may carry (concepts.md
// "Document"), and the package's reserved directory (principle 13), read the
// same way wherever they are needed.

/** The package's own directory in a vault: scripts, checks, compact traces. */
export const PACKAGE_DIRECTORY = '.vault';

/**
 * Whether `path` is inside the package's directory — compared ignoring case,
 * as a case-insensitive filesystem would see it, so `.Vault/` is no way round.
 */
export function inPackageDirectory(path: string): boolean {
  return path.split('/')[0]?.toLowerCase() === PACKAGE_DIRECTORY;
}

/** A document is a Markdown file; only these carry frontmatter the package reads. */
export function isDocumentPath(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

/** The document's labels; anything but a list of strings carries none. */
export function labelsOf(frontmatter: Readonly<Record<string, unknown>>): string[] {
  const labels = frontmatter['labels'];
  return Array.isArray(labels) && labels.every((l) => typeof l === 'string' && l !== '') ? [...labels] : [];
}
