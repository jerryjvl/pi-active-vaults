// The standard keys a document's frontmatter may carry (concepts.md
// "Document"), read the same way wherever they are needed.

/** A document is a Markdown file; only these carry frontmatter the package reads. */
export function isDocumentPath(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

/** The document's labels; anything but a list of strings carries none. */
export function labelsOf(frontmatter: Readonly<Record<string, unknown>>): string[] {
  const labels = frontmatter['labels'];
  return Array.isArray(labels) && labels.every((l) => typeof l === 'string' && l !== '') ? [...labels] : [];
}
