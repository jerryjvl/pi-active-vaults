// Public surface of the documents module: Markdown with optional YAML
// frontmatter, read as data (also as committed in a revision), its standard
// keys, and rewritten without disturbing untouched content.

export { describeDocumentError, parseDocument, type DocumentError, type ParsedDocument } from './frontmatter.ts';
export { updateFrontmatter, type FrontmatterChanges, type FrontmatterValue } from './update.ts';
export { isDocumentPath, labelsOf } from './standard.ts';
export { readDocumentAt, type CommittedDocument } from './committed.ts';
