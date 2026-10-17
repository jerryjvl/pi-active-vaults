// Which forge a vault's remote is on, and which project there: the remote's
// host names a configured forge (by host name; a port in either is ignored,
// since an ssh port is not the API's), and its path names the project —
// GitLab's may be nested in groups.

import type { ForgeEntry } from '../config/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { ForgeAdapter, ForgeDepsBase, ForgeError } from './adapter.ts';
import { giteaAdapter } from './gitea.ts';
import { githubAdapter } from './github.ts';
import { gitlabAdapter } from './gitlab.ts';

const URL_FORM = /^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/;
const SCP_FORM = /^[^@/]+@([^:/]+):(.+?)(?:\.git)?\/?$/;

const hostname = (host: string): string => host.replace(/:\d+$/, '').toLowerCase();

export function forgeProject(forges: readonly ForgeEntry[], remote: string): Result<{ entry: ForgeEntry; project: string }, ForgeError> {
  const parsed = URL_FORM.exec(remote) ?? SCP_FORM.exec(remote);
  const host = parsed?.[1]?.toLowerCase() ?? '';
  const project = parsed?.[2] ?? '';
  const entry = forges.find((f) => hostname(f.host) === host);
  if (entry === undefined || project === '' || project.split('/').some((part) => part === '' || part === '..')) return err({ reason: 'no-forge', host });
  return ok({ entry, project });
}

export function forgeAdapter(entry: ForgeEntry, project: string, deps: ForgeDepsBase): ForgeAdapter {
  switch (entry.type) {
    case 'gitea':
      return giteaAdapter(entry, project, deps);
    case 'github':
      return githubAdapter(entry, project, deps);
    case 'gitlab':
      return gitlabAdapter(entry, project, deps);
  }
}
