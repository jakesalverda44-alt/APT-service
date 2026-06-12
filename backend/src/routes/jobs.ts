import { Router } from 'express';
import { pool } from '../db';
import { requireAuth, AuthRequest } from '../auth';
import { onPmJobComplete } from '../pm';

const router = Router();
router.use(requireAuth);

// Dispatch List equivalent: filterable job grid.
router.get('/', async (req, res) => {
  const { status, type, q } = req.query as Record<string, string | undefined>;
  const params: unknown[] = [];
  const where: string[] = [];
  if (status) { params.push(status); where.push(`j.status = $${params.length}`); }
  if (type)   { params.push(type);   where.push(`j.type = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(c.name ILIKE $${params.length} OR l.name ILIKE $${params.length}
                 OR j.summary ILIKE $${params.length} OR j.number::text LIKE $${params.length})`);
  }
  const { rows } = await pool.query(
    `SELECT j.id, j.number, j.type, j.priority, j.status, j.summary, j.created_at, j.completed_at,
            c.name AS customer_name, l.name AS location_name, l.city,
            (SELECT min(d.scheduled_start) FROM service.dispatches d
             WHERE d.job_id = j.id AND d.status NOT IN ('complete','cancelled')) AS next_visit
     FROM service.jobs j
     LEFT JOIN service.customers c ON c.id = j.customer_id
     LEFT JOIN service.locations l ON l.id = j.location_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY j.created_at DESC LIMIT 200`,
    params
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const job = (await pool.query(
    `SELECT j.*, c.name AS customer_name, l.name AS location_name, l.address1, l.city, l.state, l.zip,
            l.access_notes, l.phones AS location_phones,
            a.plan_name, a.type_code AS agreement_type
     FROM service.jobs j
     LEFT JOIN service.customers c ON c.id = j.customer_id
     LEFT JOIN service.locations l ON l.id = j.location_id
     LEFT JOIN service.agreements a ON a.id = j.agreement_id
     WHERE j.id = $1`, [req.params.id])).rows[0];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const [notes, dispatches, lines] = await Promise.all([
    pool.query('SELECT * FROM service.job_notes WHERE job_id = $1 ORDER BY created_at', [req.params.id]),
    pool.query(
      `SELECT d.*, u.name AS tech_name FROM service.dispatches d
       LEFT JOIN public.users u ON u.id = d.tech_id
       WHERE d.job_id = $1 ORDER BY d.scheduled_start`, [req.params.id]),
    pool.query('SELECT * FROM service.job_lines WHERE job_id = $1 ORDER BY created_at', [req.params.id]),
  ]);
  res.json({ ...job, notes: notes.rows, dispatches: dispatches.rows, lines: lines.rows });
});

router.post('/', async (req: AuthRequest, res) => {
  const { customer_id, location_id, equipment_id, agreement_id, type, priority, summary, customer_po } = req.body || {};
  const { rows } = await pool.query(
    `INSERT INTO service.jobs (customer_id, location_id, equipment_id, agreement_id,
                               type, priority, summary, customer_po, status, created_by)
     VALUES ($1,$2,$3,$4,COALESCE($5,'repair'),COALESCE($6,'normal'),$7,$8,'pending',$9)
     RETURNING *`,
    [customer_id, location_id, equipment_id, agreement_id, type, priority, summary, customer_po, req.user!.id]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const allowed = ['status', 'priority', 'summary', 'customer_po', 'type', 'customer_id', 'location_id', 'equipment_id', 'agreement_id'];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const k of allowed) {
    if (k in (req.body || {})) {
      params.push(req.body[k]);
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  if (req.body.status === 'complete') sets.push('completed_at = now()');
  params.push(req.params.id);
  const before = (await pool.query('SELECT status FROM service.jobs WHERE id = $1', [req.params.id])).rows[0];
  const { rows } = await pool.query(
    `UPDATE service.jobs SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'Job not found' });
  // ESC behavior: completing an agreement PM advances the task's next-due
  // date and decrements the plan's visits-remaining counter.
  if (req.body.status === 'complete' && before?.status !== 'complete' && rows[0].type === 'pm') {
    await onPmJobComplete(rows[0]);
  }
  res.json(rows[0]);
});

// Parts & labor lines (feed the invoice).
router.post('/:id/lines', async (req, res) => {
  const { kind, description, qty, unit_cost, unit_price, taxable } = req.body || {};
  if (!description) return res.status(400).json({ error: 'Description required' });
  const { rows } = await pool.query(
    `INSERT INTO service.job_lines (job_id, kind, description, qty, unit_cost, unit_price, taxable)
     VALUES ($1,COALESCE($2,'part'),$3,COALESCE($4::numeric,1),$5::numeric,COALESCE($6::numeric,0),COALESCE($7,true)) RETURNING *`,
    [req.params.id, kind, description, qty, unit_cost, unit_price, taxable]);
  res.status(201).json(rows[0]);
});

router.delete('/lines/:lineId', async (req, res) => {
  await pool.query('DELETE FROM service.job_lines WHERE id = $1', [req.params.lineId]);
  res.json({ ok: true });
});

// Append-only note timeline (ESC dispatch-notes behavior — no edit, no delete).
router.post('/:id/notes', async (req: AuthRequest, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Note body required' });
  const { rows } = await pool.query(
    `INSERT INTO service.job_notes (job_id, author_id, author_name, body)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.params.id, req.user!.id, req.user!.name, body]
  );
  res.status(201).json(rows[0]);
});

export default router;
