import { Router } from 'express';
import { pool } from '../db';
import { requireAuth, requireOffice, AuthRequest } from '../auth';

const router = Router();
router.use(requireAuth, requireOffice);

router.get('/', async (req, res) => {
  const { status, q } = req.query as Record<string, string | undefined>;
  const params: unknown[] = [];
  const where: string[] = [];
  if (status) { params.push(status); where.push(`qt.status = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(c.name ILIKE $${params.length} OR qt.number::text LIKE $${params.length}
                 OR qt.summary ILIKE $${params.length})`);
  }
  const { rows } = await pool.query(
    `SELECT qt.id, qt.number, qt.status, qt.summary, qt.valid_until, qt.created_at, qt.tax,
            c.name AS customer_name, l.name AS location_name,
            COALESCE((SELECT SUM(ql.qty * ql.unit_price) FROM service.quote_lines ql
                      WHERE ql.quote_id = qt.id), 0) + qt.tax AS total
     FROM service.quotes qt
     JOIN service.customers c ON c.id = qt.customer_id
     LEFT JOIN service.locations l ON l.id = qt.location_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY qt.created_at DESC LIMIT 200`, params);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const quote = (await pool.query(
    `SELECT qt.*, c.name AS customer_name, c.esc_account_no,
            c.billing_address1, c.billing_city, c.billing_state, c.billing_zip,
            l.name AS location_name, l.address1 AS location_address, l.city AS location_city,
            l.state AS location_state, l.zip AS location_zip,
            j.number AS job_number
     FROM service.quotes qt
     JOIN service.customers c ON c.id = qt.customer_id
     LEFT JOIN service.locations l ON l.id = qt.location_id
     LEFT JOIN service.jobs j ON j.id = qt.job_id
     WHERE qt.id = $1`, [req.params.id])).rows[0];
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  const lines = (await pool.query(
    'SELECT * FROM service.quote_lines WHERE quote_id = $1 ORDER BY created_at', [req.params.id])).rows;
  res.json({ ...quote, lines });
});

router.post('/', async (req: AuthRequest, res) => {
  const { customer_id, location_id, equipment_id, summary, valid_until } = req.body || {};
  if (!customer_id) return res.status(400).json({ error: 'customer_id required' });
  const { rows } = await pool.query(
    `INSERT INTO service.quotes (customer_id, location_id, equipment_id, summary, valid_until, created_by)
     VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE + 30),$6) RETURNING *`,
    [customer_id, location_id, equipment_id, summary, valid_until || null, req.user!.id]);
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const allowed = ['status', 'summary', 'tax', 'valid_until', 'notes', 'location_id', 'equipment_id'];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const f of allowed) {
    if (f in (req.body || {})) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE service.quotes SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'Quote not found' });
  res.json(rows[0]);
});

router.post('/:id/lines', async (req, res) => {
  const { kind, description, qty, unit_cost, unit_price, taxable } = req.body || {};
  if (!description) return res.status(400).json({ error: 'Description required' });
  const { rows } = await pool.query(
    `INSERT INTO service.quote_lines (quote_id, kind, description, qty, unit_cost, unit_price, taxable)
     VALUES ($1,COALESCE($2,'part'),$3,COALESCE($4::numeric,1),$5::numeric,COALESCE($6::numeric,0),COALESCE($7,true))
     RETURNING *`,
    [req.params.id, kind, description, qty, unit_cost, unit_price, taxable]);
  res.status(201).json(rows[0]);
});

router.delete('/lines/:lineId', async (req, res) => {
  await pool.query('DELETE FROM service.quote_lines WHERE id = $1', [req.params.lineId]);
  res.json({ ok: true });
});

// Accept: ESC's quote -> dispatch conversion. Creates the repair job and
// copies the quoted lines onto it so the eventual invoice matches the quote.
router.post('/:id/accept', async (req: AuthRequest, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const quote = (await client.query(
      `SELECT * FROM service.quotes WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!quote) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Quote not found' }); }
    if (quote.status === 'accepted') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Quote already accepted' });
    }
    const job = (await client.query(
      `INSERT INTO service.jobs (customer_id, location_id, equipment_id, type, status, summary, created_by)
       VALUES ($1,$2,$3,'repair','pending',$4,$5) RETURNING *`,
      [quote.customer_id, quote.location_id, quote.equipment_id,
       quote.summary ? `Quote #${quote.number}: ${quote.summary}` : `Accepted quote #${quote.number}`,
       req.user!.id])).rows[0];
    await client.query(
      `INSERT INTO service.job_lines (job_id, kind, description, qty, unit_cost, unit_price, taxable)
       SELECT $1, kind, description, qty, unit_cost, unit_price, taxable
       FROM service.quote_lines WHERE quote_id = $2`, [job.id, quote.id]);
    await client.query(
      `INSERT INTO service.job_notes (job_id, author_id, author_name, body)
       VALUES ($1,$2,$3,$4)`,
      [job.id, req.user!.id, req.user!.name, `Created from accepted quote #${quote.number}`]);
    await client.query(
      `UPDATE service.quotes SET status = 'accepted', accepted_at = now(), job_id = $1 WHERE id = $2`,
      [job.id, quote.id]);
    await client.query('COMMIT');
    res.status(201).json(job);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

export default router;
