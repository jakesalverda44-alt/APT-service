import { Router } from 'express';
import { pool } from '../db';
import { requireAuth } from '../auth';

const router = Router();
router.use(requireAuth);

// Customer Center list: search across customer name, location name and
// address (ESC searches the same fields). Returns locations flattened so the
// grid matches ESC's Full Name / Location Name / Address columns. Defaults to
// active customers only, matching ESC's "Active Customers" filter; the total
// (pre-limit) count is returned so the UI can show "showing N of M".
router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status || 'active');   // active | inactive | all
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const params: unknown[] = [];
  const conds: string[] = [];
  if (status === 'active' || status === 'inactive') {
    params.push(status);
    conds.push(`c.status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(c.name ILIKE $${params.length} OR c.esc_account_no LIKE $${params.length}
                 OR l.name ILIKE $${params.length} OR l.address1 ILIKE $${params.length}
                 OR l.city ILIKE $${params.length})`);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const total = Number((await pool.query(
    `SELECT count(*)::int AS n FROM service.customers c
     LEFT JOIN service.locations l ON l.customer_id = c.id ${where}`, params)).rows[0].n);

  params.push(limit);
  const { rows } = await pool.query(
    `SELECT c.id AS customer_id, c.name AS customer_name, c.esc_account_no, c.status,
            l.id AS location_id, l.name AS location_name,
            l.address1, l.city, l.state, l.zip
     FROM service.customers c
     LEFT JOIN service.locations l ON l.customer_id = c.id
     ${where}
     ORDER BY c.name, l.esc_location_no
     LIMIT $${params.length}`,
    params
  );
  res.json({ rows, total });
});

// Full detail for the right-hand panel: customer + locations (with equipment),
// active agreements, recent jobs and invoices.
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const customer = (await pool.query('SELECT * FROM service.customers WHERE id = $1', [id])).rows[0];
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const [locations, agreements, jobs, invoices, quotes] = await Promise.all([
    pool.query(
      `SELECT l.*,
              COALESCE(json_agg(e.* ORDER BY e.created_at) FILTER (WHERE e.id IS NOT NULL), '[]') AS equipment
       FROM service.locations l
       LEFT JOIN service.equipment e ON e.location_id = l.id
       WHERE l.customer_id = $1 GROUP BY l.id ORDER BY l.esc_location_no`, [id]),
    pool.query(
      `SELECT * FROM service.agreements WHERE customer_id = $1
       ORDER BY status = 'active' DESC, expires_on DESC NULLS LAST`, [id]),
    pool.query(
      `SELECT j.id, j.number, j.type, j.status, j.summary, j.created_at, l.name AS location_name
       FROM service.jobs j LEFT JOIN service.locations l ON l.id = j.location_id
       WHERE j.customer_id = $1 ORDER BY j.created_at DESC LIMIT 15`, [id]),
    pool.query(
      `SELECT id, number, status, total, balance_due, issued_on
       FROM service.invoices WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 15`, [id]),
    pool.query(
      `SELECT qt.id, qt.number, qt.status, qt.summary, qt.created_at,
              COALESCE((SELECT SUM(ql.qty * ql.unit_price) FROM service.quote_lines ql
                        WHERE ql.quote_id = qt.id), 0) + qt.tax AS total
       FROM service.quotes qt WHERE qt.customer_id = $1
       ORDER BY qt.created_at DESC LIMIT 10`, [id]),
  ]);
  res.json({
    ...customer,
    locations: locations.rows,
    agreements: agreements.rows,
    recent_jobs: jobs.rows,
    recent_invoices: invoices.rows,
    recent_quotes: quotes.rows,
  });
});

router.post('/', async (req, res) => {
  const { name, billing_address1, billing_city, billing_state, billing_zip, phones, email, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  const { rows } = await pool.query(
    `INSERT INTO service.customers (name, billing_address1, billing_city, billing_state, billing_zip, phones, email, notes)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,'{}'::jsonb),$7,$8) RETURNING *`,
    [name, billing_address1, billing_city, billing_state, billing_zip,
     phones ? JSON.stringify(phones) : null, email, notes]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const allowed = ['name', 'billing_address1', 'billing_address2', 'billing_city', 'billing_state',
                   'billing_zip', 'email', 'credit_terms', 'status', 'notes', 'phones'];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const f of allowed) {
    if (f in (req.body || {})) {
      params.push(f === 'phones' ? JSON.stringify(req.body[f]) : req.body[f]);
      sets.push(`${f} = $${params.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE service.customers SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'Customer not found' });
  res.json(rows[0]);
});

router.patch('/locations/:locId', async (req, res) => {
  const allowed = ['name', 'address1', 'address2', 'city', 'state', 'zip', 'access_notes',
                   'contact_name', 'email', 'tax_code', 'status', 'notes', 'phones'];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const f of allowed) {
    if (f in (req.body || {})) {
      params.push(f === 'phones' ? JSON.stringify(req.body[f]) : req.body[f]);
      sets.push(`${f} = $${params.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.locId);
  const { rows } = await pool.query(
    `UPDATE service.locations SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'Location not found' });
  res.json(rows[0]);
});

router.post('/locations/:locId/equipment', async (req, res) => {
  const { kind, manufacturer, model, serial, kw, fuel, install_date, warranty_expires, notes } = req.body || {};
  const { rows } = await pool.query(
    `INSERT INTO service.equipment (location_id, kind, manufacturer, model, serial, kw, fuel,
                                    install_date, warranty_expires, notes)
     VALUES ($1,COALESCE($2,'generator'),$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.params.locId, kind, manufacturer, model, serial, kw, fuel, install_date, warranty_expires, notes]);
  res.status(201).json(rows[0]);
});

router.post('/:id/locations', async (req, res) => {
  const { name, address1, address2, city, state, zip, access_notes, contact_name, phones, email } = req.body || {};
  const { rows } = await pool.query(
    `INSERT INTO service.locations (customer_id, name, address1, address2, city, state, zip,
                                    access_notes, contact_name, phones, email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'{}'::jsonb),$11) RETURNING *`,
    [req.params.id, name, address1, address2, city, state, zip,
     access_notes, contact_name, phones ? JSON.stringify(phones) : null, email]
  );
  res.status(201).json(rows[0]);
});

export default router;
