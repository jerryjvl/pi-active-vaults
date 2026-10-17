// Public surface of the templates module: naming a template, checking its
// marker, and creating a vault from it.

export {
  createFromTemplate,
  inspectTemplate,
  resolveTemplateSpec,
  type CreateFromTemplate,
  type CreatedVault,
  type TemplateError,
  type TemplateMarker,
  type TemplateSource,
  type TemplateSummary,
} from './templates.ts';
