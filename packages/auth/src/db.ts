// Drizzle client for the Better Auth stack.
//
// Design decision #1 (see codev/plans/59-*): the db client and schema live
// INSIDE packages/auth rather than a separate packages/db, so the whole auth
// stack is one self-contained unit that #60 can relocate or merge wholesale.
// Every table it touches is in the `auth` Postgres schema (src/schema.ts); it
// shares no Drizzle code with apps/api.
//
// node-postgres' `drizzle(connectionString)` creates the pool lazily, so this
// module can be constructed without opening a connection; the first query is
// what connects.
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';

import { getEnv } from './env';
import * as schema from './schema';

export function createDb() {
  return drizzle(getEnv().DATABASE_URL, { schema });
}

export type Db = ReturnType<typeof createDb>;

/** `select 1` on the auth database; throws when it cannot answer. */
export async function pingDatabase(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
