/* eslint-disable no-console */
import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const pool = createPool(process.env.DATABASE_URL ?? 'postgres://n409:n409_dev@localhost:5432/n409_dev');
try {
  const applied = await migrate(pool, { log: console.log });
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Already up to date.');
} finally {
  await pool.end();
}
