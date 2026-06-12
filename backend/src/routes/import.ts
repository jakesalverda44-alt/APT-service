import { Router } from 'express';
import express from 'express';
import { pool } from '../db';
import { requireAuth, requireOffice } from '../auth';
import { parseEscCustomerList } from '../escParser';
import { importEscCsv } from '../escCsv';
import { AuthRequest } from '../auth';

const router = Router();

// The nightly ESC sync (Windows scheduled task on the ESC server) pushes CSVs
// with a long-lived key instead of a 12h user token. Office users keep using
// the normal login path.
function apiKeyOrOffice(req: AuthRequest, res: Parameters<typeof requireOffice>[1], next: () => void) {
  const key = process.env.IMPORT_API_KEY;
  if (key && req.headers['x-api-key'] === key) return next();
  requireAuth(req, res, () => requireOffice(req, res, next));
}

router.use((req, res, next) => {
  if (req.path === '/esc-csv') return next();   // guarded per-route below
  requireAuth(req as AuthRequest, res, () => requireOffice(req as AuthRequest, res, next));
});

// Upload one CSV from the ESC SQL-Server export (table auto-detected from the
// header). Idempotent: rows upsert on their ESC numbers. Upload order:
// customers, locations, agreements, recurrence, tasks, equipment — but any
// order works; rows whose parents are missing are reported and can be re-run.
router.post(
  '/esc-csv',
  apiKeyOrOffice,
  express.text({ type: ['text/csv', 'text/plain', 'application/octet-stream'], limit: '80mb' }),
  async (req, res) => {
    if (typeof req.body !== 'string' || req.body.length < 10) {
      return res.status(400).json({ error: 'Upload the CSV file as the request body' });
    }
    try {
      const outcome = await importEscCsv(String(req.query.filename || 'upload.csv'), req.body);
      res.json(outcome);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }
);

// Upload an ESC "Customer List Report" PDF. Parses, stages into import_rows,
// normalizes into customers/locations (idempotent upserts on ESC numbers),
// and returns the stats. Re-uploading the same or overlapping reports is safe.
router.post(
  '/esc-customers',
  express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '30mb' }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) {
      return res.status(400).json({ error: 'Upload the PDF file as the request body' });
    }
    let parsed;
    try {
      parsed = await parseEscCustomerList(req.body);
    } catch (err) {
      return res.status(400).json({ error: `Could not read PDF: ${(err as Error).message}` });
    }
    if (!parsed.customers.length) {
      return res.status(400).json({ error: 'No customers found — is this an ESC Customer List Report?' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const filename = String(req.query.filename || 'upload.pdf');
      const batch = (await client.query(
        `INSERT INTO service.import_batches (source, filename, filters, stats)
         VALUES ('esc_customer_list_pdf', $1, $2, $3) RETURNING id`,
        [filename, parsed.filters.join('; ') || null,
         JSON.stringify({ customers: parsed.customers.length, warnings: parsed.warnings.slice(0, 50) })]
      )).rows[0];

      const values: string[] = [];
      const params: unknown[] = [batch.id];
      let i = 1;
      for (const c of parsed.customers) {
        params.push('customer', JSON.stringify(c.customer));
        values.push(`($1, $${++i}, $${++i}::jsonb)`);
        for (const l of c.locations) {
          params.push('location', JSON.stringify(l));
          values.push(`($1, $${++i}, $${++i}::jsonb)`);
        }
      }
      await client.query(
        `INSERT INTO service.import_rows (batch_id, row_kind, raw) VALUES ${values.join(',')}`,
        params
      );
      const results = (await client.query(
        'SELECT * FROM service.import_normalize($1)', [batch.id])).rows;
      const errors = (await client.query(
        `SELECT row_kind, raw->>'name' AS name, error FROM service.import_rows
         WHERE batch_id = $1 AND status = 'error' LIMIT 20`, [batch.id])).rows;
      await client.query('COMMIT');
      res.json({ batch_id: batch.id, filters: parsed.filters, warnings: parsed.warnings.slice(0, 20), results, errors });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Import failed; nothing was saved' });
    } finally {
      client.release();
    }
  }
);

router.get('/batches', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, source, filename, filters, stats, created_at
     FROM service.import_batches ORDER BY created_at DESC LIMIT 25`);
  res.json(rows);
});

export default router;
