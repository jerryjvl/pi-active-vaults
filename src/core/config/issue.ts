// A problem found while validating configuration. Issues name the config path
// and what is wrong, and never repeat a value: a rejected value may be a secret
// someone pasted by mistake, or a URL with credentials in it.

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}
