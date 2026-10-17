// The actors module's tables in `state.sqlite`: review records, kept per
// reviewer, and actor holds. Migrations are append-only.

import type { ModuleSchema } from '../store/index.ts';

export const actorsSchema: ModuleSchema = {
  module: 'actors',
  migrations: [
    {
      version: 1,
      sql: `CREATE TABLE actors_reviews (
        vault TEXT NOT NULL,
        actor TEXT NOT NULL,
        sha TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (vault, actor)
      ) STRICT`,
    },
    {
      // One latest review per reviewer, not per actor (accept binds to the approver's own).
      version: 2,
      sql: `CREATE TABLE actors_reviews_by_reviewer (
        vault TEXT NOT NULL,
        actor TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        sha TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (vault, actor, reviewer)
      ) STRICT;
      INSERT INTO actors_reviews_by_reviewer (vault, actor, reviewer, sha, at) SELECT vault, actor, reviewer, sha, at FROM actors_reviews;
      DROP TABLE actors_reviews;
      ALTER TABLE actors_reviews_by_reviewer RENAME TO actors_reviews`,
    },
    {
      // One writer per actor: the process (ID and start time) and session holding it.
      version: 3,
      sql: `CREATE TABLE actors_holds (
        vault TEXT NOT NULL,
        actor TEXT NOT NULL,
        pid INTEGER NOT NULL,
        started TEXT NOT NULL,
        session TEXT NOT NULL,
        since TEXT NOT NULL,
        PRIMARY KEY (vault, actor)
      ) STRICT`,
    },
  ],
};
