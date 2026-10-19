// The models the axes of a vault's contracts ask for (concepts.md "Judgement
// axes"): what `vault doctor` checks against the installation's models. Read
// from the accepted `main`, like everything that decides.
//
// Axes are inherited down the tree, so the same axis would appear in every
// directory below the contract that defines it; each (axis, model) is listed
// once, at the shallowest contract that gives it. A contract that cannot be
// read or parsed offers none: judging reports that itself, and this listing
// only ever says less.

import { ROOT_CONTRACT } from '../contracts/index.ts';
import { listFiles, type Git, type GitError } from '../git/index.ts';
import { UNCACHED_READS, acceptedContracts, type AcceptedMain, type AcceptedReads } from '../integrity/index.ts';
import { ok, type Result } from '../result/index.ts';
import { parseAxes } from './axes.ts';

export interface AxisRequest {
  /** The contract whose directory the axis was first in effect in. */
  readonly contract: string;
  readonly axis: string;
  /** The judgement model it names; absent: the default. */
  readonly model?: string;
}

/** Every (axis, model) the accepted main's contracts ask for, shallowest contract first. */
export async function axisModelRequests(
  git: Git, repo: string, accepted: AcceptedMain, reads: AcceptedReads = UNCACHED_READS,
): Promise<Result<AxisRequest[], GitError>> {
  const files = await listFiles(git, repo, accepted.sha);
  if (!files.ok) return files;
  const directories = [...new Set(['', ...files.value.filter((f) => f === ROOT_CONTRACT || f.endsWith(`/${ROOT_CONTRACT}`)).map((f) => f.slice(0, Math.max(0, f.length - ROOT_CONTRACT.length - 1)))])]
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  const contracts = await acceptedContracts(reads, git, repo, accepted);
  const found = new Map<string, AxisRequest>();
  for (const directory of directories) {
    const effective = await contracts.forDirectory(directory);
    if (!effective.ok) continue;
    const defined = effective.value.values['axes'];
    const axes = defined === undefined ? undefined : parseAxes(defined);
    if (axes === undefined || !axes.ok) continue;
    for (const axis of axes.value) {
      const key = `${axis.name}\0${axis.model ?? ''}`;
      if (!found.has(key)) {
        found.set(key, { contract: directory === '' ? ROOT_CONTRACT : `${directory}/${ROOT_CONTRACT}`, axis: axis.name, ...(axis.model === undefined ? {} : { model: axis.model }) });
      }
    }
  }
  return ok([...found.values()]);
}
