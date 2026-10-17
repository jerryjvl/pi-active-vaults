// Public surface of the documents module: Markdown with optional YAML
// frontmatter, read as data and rewritten without disturbing untouched content.

export { describeDocumentError, parseDocument, type DocumentError, type ParsedDocument } from './frontmatter.ts';
export { updateFrontmatter, type FrontmatterChanges, type FrontmatterValue } from './update.ts';
