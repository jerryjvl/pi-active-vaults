// What the forge reported merged: the record of each proposal merged in the
// forge, per vault and pull request (`forge_merges` in the state store), and
// the head it was merged at. Written once per pull request; read by the merge
// checks (`merges.ts`) and by proposing (`sync.ts`), which may replace the
// forge's copy of an actor branch only while it still holds one of these heads.

import type { Sha } from '../git/index.ts';
import type { ModuleSchema, Queryable, Store } from '../store/index.ts';

export const forgeSchema: ModuleSchema = {
  module: 'forge',
  migrations: [
    {
      version: 1,
      sql: `CREATE TABLE forge_merges (
        vault TEXT NOT NULL,
        pull INTEGER NOT NULL,
        url TEXT NOT NULL,
        actor TEXT NOT NULL,
        head TEXT NOT NULL,
        main TEXT NOT NULL,
        kept INTEGER NOT NULL CHECK (kept IN (0, 1)),
        at TEXT NOT NULL,
        PRIMARY KEY (vault, pull)
      ) STRICT`,
    },
  ],
};

export interface MergeResult {
  readonly vault: string;
  readonly pull: number;
  readonly url: string;
  readonly actor: string;
  readonly head: Sha;
  /** The accepted main it was judged against. */
  readonly main: Sha;
  /** Whether the head is in that main: its commits, and what is attached to them, reached it. */
  readonly kept: boolean;
  readonly at: string;
}

type Row = Omit<MergeResult, 'kept'> & { kept: number };

const COLUMNS = 'vault, pull, url, actor, head, main, kept, at';

/** The pull requests of the vault already judged. */
export function judgedPulls(store: Queryable, vault: string): Set<number> {
  return new Set(store.all<{ pull: number }>('SELECT pull FROM forge_merges WHERE vault = ?', [vault]).map((r) => r.pull));
}

/** Records a merge's result unless it is recorded already; whether it was recorded now. */
export function recordMerge(store: Store, r: MergeResult): boolean {
  return store.run(
    `INSERT INTO forge_merges (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [r.vault, r.pull, r.url, r.actor, r.head, r.main, r.kept ? 1 : 0, r.at],
  ).changes === 1;
}

/** The vault's merges whose commits did not reach `main`, newest pull request first. */
export function lostRows(store: Queryable, vault: string): MergeResult[] {
  return store.all<Row>(`SELECT ${COLUMNS} FROM forge_merges WHERE vault = ? AND kept = 0 ORDER BY pull DESC`, [vault]).map((r) => ({ ...r, kept: false }));
}

/** Every head the forge reported merged from the actor's branch. */
export function mergedHeads(store: Queryable, vault: string, actor: string): Sha[] {
  return store.all<{ head: Sha }>('SELECT head FROM forge_merges WHERE vault = ? AND actor = ?', [vault, actor]).map((r) => r.head);
}
