// Public surface of the templates module: naming a template, checking its
// marker, and creating a vault from it — or an empty one.

export {
  createEmptyVault,
  createFromTemplate,
  inspectTemplate,
  resolveTemplateSpec,
  type CreateEmptyVault,
  type CreateFromTemplate,
  type CreatedVault,
  type TemplateError,
  type TemplateMarker,
  type TemplateSource,
  type TemplateSummary,
} from './templates.ts';
