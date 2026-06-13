import { Router } from 'express';
import { pool } from '../db';
import { requireAuth, requireOffice } from '../auth';
import { generatePmJobs } from '../pm';

const router = Router();
router.use(requireAuth);

const AGREEMENT_FIELDS = [
  'customer_id', 'location_id', 'type_code', 'plan_name', 'billing_freq', 'price',
  'original_contract_date', 'last_renewal_date', 'expires_on', 'auto_renew',
  'visits_major_total', 'visits_major_remaining', 'visits_minor_total',
  'visits_minor_remaining', 'status', 'notes', 'esc_agreement_no',
] as const;

// Agreement List grid (ESC columns: customer, agreement #, type, dates, location).
// view=expiring&days=60 -> the renewal call list: active agreements expiring in
// the window (or already lapsed but not cancelled), soonest first, with phones.
router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const view = String(req.query.view || 'all');     // all | active | expiring | expired
  const days = Math.min(Number(req.query.days) || 60, 365);
  const params: unknown[] = [];
  const conds: string[] = [];
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(c.name ILIKE $${params.length} OR a.esc_agreement_no LIKE $${params.length}
                 OR a.type_code ILIKE $${params.length} OR l.name ILIKE $${params.length})`);
  }
  if (view === 'active') conds.push(`a.status = 'active'`);
  if (view === 'expired') conds.push(`a.status = 'expired'`);
  if (view === 'expiring') {
    params.push(days);
    conds.push(`a.status = 'active' AND a.expires_on IS NOT NULL
                AND a.expires_on <= CURRENT_DATE + $${params.length}::int`);
  }
  const order = view === 'expiring' ? 'a.expires_on ASC' : 'c.name';
  const { rows } = await pool.query(
    `SELECT a.id, a.esc_agreement_no, a.type_code, a.plan_name, a.status, a.price,
            a.original_contract_date, a.last_renewal_date, a.expires_on,
            a.visits_major_remaining, a.visits_minor_remaining,
            c.name AS customer_name, c.esc_account_no, c.phones AS customer_phones,
            l.name AS location_name, l.address1
     FROM service.agreements a
     JOIN service.customers c ON c.id = a.customer_id
     LEFT JOIN service.locations l ON l.id = a.location_id
     ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
     ORDER BY ${order} LIMIT 300`, params);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const agreement = (await pool.query(
    `SELECT a.*, c.name AS customer_name, c.esc_account_no, c.phones AS customer_phones,
            l.name AS location_name, l.address1, l.city, l.state, l.zip
     FROM service.agreements a
     JOIN service.customers c ON c.id = a.customer_id
     LEFT JOIN service.locations l ON l.id = a.location_id
     WHERE a.id = $1`, [req.params.id])).rows[0];
  if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
  const [tasks, equipment, jobs] = await Promise.all([
    pool.query('SELECT * FROM service.agreement_tasks WHERE agreement_id = $1 ORDER BY next_due_on', [req.params.id]),
    pool.query(
      `SELECT e.* FROM service.agreement_equipment ae
       JOIN service.equipment e ON e.id = ae.equipment_id WHERE ae.agreement_id = $1`, [req.params.id]),
    pool.query(
      `SELECT id, number, type, status, summary, created_at, completed_at
       FROM service.jobs WHERE agreement_id = $1 ORDER BY created_at DESC LIMIT 20`, [req.params.id]),
  ]);
  res.json({ ...agreement, tasks: tasks.rows, equipment: equipment.rows, jobs: jobs.rows });
});

router.post('/', requireOffice, async (req, res) => {
  const b = req.body || {};
  if (!b.customer_id) return res.status(400).json({ error: 'customer_id required' });
  // New agreements start with remaining = total unless told otherwise.
  if (b.visits_major_total != null && b.visits_major_remaining == null) b.visits_major_remaining = b.visits_major_total;
  if (b.visits_minor_total != null && b.visits_minor_remaining == null) b.visits_minor_remaining = b.visits_minor_total;
  const cols: string[] = [];
  const params: unknown[] = [];
  for (const f of AGREEMENT_FIELDS) {
    if (f in b) { params.push(b[f]); cols.push(f); }
  }
  const { rows } = await pool.query(
    `INSERT INTO service.agreements (${cols.join(',')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    params
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', requireOffice, async (req, res) => {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const f of AGREEMENT_FIELDS) {
    if (f in (req.body || {})) { params.push(req.body[f]); sets.push(`${f} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE service.agreements SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'Agreement not found' });
  res.json(rows[0]);
});

// Renew: stamp the renewal date, set the new expiration, refill visit counters.
// create_invoice=true also raises the renewal invoice at the agreement price.
router.post('/:id/renew', requireOffice, async (req, res) => {
  const { expires_on, price, create_invoice } = req.body || {};
  if (!expires_on) return res.status(400).json({ error: 'expires_on required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const agreement = (await client.query(
      `UPDATE service.agreements SET
         last_renewal_date = CURRENT_DATE,
         expires_on = $2,
         price = COALESCE($3::numeric, price),
         status = 'active',
         visits_major_remaining = visits_major_total,
         visits_minor_remaining = visits_minor_total
       WHERE id = $1 RETURNING *`,
      [req.params.id, expires_on, price ?? null])).rows[0];
    if (!agreement) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Agreement not found' });
    }
    let invoiceId: string | null = null;
    if (create_invoice) {
      const amount = Number(agreement.price) || 0;
      const terms = (await client.query(
        'SELECT credit_terms FROM service.customers WHERE id = $1',
        [agreement.customer_id])).rows[0]?.credit_terms || 'DUE ON RECEIPT';
      invoiceId = (await client.query(
        `INSERT INTO service.invoices
           (customer_id, location_id, agreement_id, status, terms,
            subtotal, tax, total, balance_due, issued_on, due_on)
         VALUES ($1,$2,$3,'draft',$4,$5,0,$5,$5,CURRENT_DATE,CURRENT_DATE)
         RETURNING id`,
        [agreement.customer_id, agreement.location_id, agreement.id, terms, amount])).rows[0].id;
    }
    await client.query('COMMIT');
    res.json({ ...agreement, invoice_id: invoiceId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.post('/:id/tasks', requireOffice, async (req, res) => {
  const { name, kind, interval_months, next_due_on, checklist } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Task name required' });
  const { rows } = await pool.query(
    `INSERT INTO service.agreement_tasks (agreement_id, name, kind, interval_months, next_due_on, checklist)
     VALUES ($1,$2,COALESCE($3,'minor'),$4,$5,COALESCE($6,'[]'::jsonb)) RETURNING *`,
    [req.params.id, name, kind, interval_months, next_due_on,
     checklist ? JSON.stringify(checklist) : null]);
  res.status(201).json(rows[0]);
});

router.patch('/tasks/:taskId', requireOffice, async (req, res) => {
  const allowed = ['name', 'kind', 'interval_months', 'next_due_on', 'checklist'];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const f of allowed) {
    if (f in (req.body || {})) {
      params.push(f === 'checklist' ? JSON.stringify(req.body[f]) : req.body[f]);
      sets.push(`${f} = $${params.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.taskId);
  const { rows } = await pool.query(
    `UPDATE service.agreement_tasks SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
  res.json(rows[0]);
});

router.delete('/tasks/:taskId', requireOffice, async (req, res) => {
  await pool.query('DELETE FROM service.agreement_tasks WHERE id = $1', [req.params.taskId]);
  res.json({ ok: true });
});

router.post('/:id/equipment', requireOffice, async (req, res) => {
  if (!req.body?.equipment_id) return res.status(400).json({ error: 'equipment_id required' });
  await pool.query(
    `INSERT INTO service.agreement_equipment (agreement_id, equipment_id)
     VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [req.params.id, req.body.equipment_id]);
  res.status(201).json({ ok: true });
});

// Run the PM scheduler on demand (it also runs automatically every 12 hours).
router.post('/generate-pms', requireOffice, async (req, res) => {
  const created = await generatePmJobs(Number(req.body?.lead_days) || 14);
  res.json({ created });
});

export default router;
