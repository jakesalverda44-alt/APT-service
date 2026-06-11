import fs from 'fs';
import path from 'path';
import { pool } from './db';

// Apply database/migrations/*.sql in order, exactly once each, at startup —
// so a Render deploy needs no manual psql step. Mirrors database/migrate.sh.
export async function runMigrations(): Promise<void> {
  const dir = path.join(__dirname, '../../database/migrations');
  if (!fs.existsSync(dir)) {
    console.log('migrations: directory not found, skipping');
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS service');
    await client.query(`CREATE TABLE IF NOT EXISTS service.schema_migrations (
      filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    // Serialize concurrent boots (e.g. two Render instances) on one lock.
    await client.query('SELECT pg_advisory_lock(727274)');
    const done = new Set(
      (await client.query('SELECT filename FROM service.schema_migrations')).rows.map((r) => r.filename)
    );
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`migrations: applying ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO service.schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}
