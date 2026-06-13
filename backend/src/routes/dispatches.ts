import { Router } from 'express';
import { pool } from '../db';
import { requireAuth, AuthRequest } from '../auth';

const router = Router();
router.use(requireAuth);

// Board data: tech columns + dispatches for the date (or a multi-day window
// for the week view) + unscheduled pending jobs (the "to be scheduled" tray).
router.get('/board', async (req, res) => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));
  const days = Math.min(Math.max(Number(req.query.days) || 1, 1), 14);
  const [techs, dispatches, unscheduled] = await Promise.all([
    pool.query(
      `SELECT id, name, role FROM public.users
       WHERE role IN ('technician','dispatcher') ORDER BY name`),
    pool.query(
      `SELECT d.*, u.name AS tech_name, j.number AS job_number, j.type AS job_type,
              j.priority, j.summary, j.agreement_id IS NOT NULL AS is_agreement_work,
              c.name AS customer_name, l.name AS location_name, l.city
       FROM service.dispatches d
       JOIN service.jobs j ON j.id = d.job_id
       LEFT JOIN public.users u ON u.id = d.tech_id
       LEFT JOIN service.customers c ON c.id = j.customer_id
       LEFT JOIN service.locations l ON l.id = j.location_id
       WHERE d.scheduled_start::date >= $1::date
         AND d.scheduled_start::date < $1::date + $2::int
         AND d.status != 'cancelled'
       ORDER BY d.scheduled_start`, [date, days]),
    pool.query(
      `SELECT j.id, j.number, j.type, j.priority, j.summary,
              c.name AS customer_name, l.name AS location_name, l.city
       FROM service.jobs j
       LEFT JOIN service.customers c ON c.id = j.customer_id
       LEFT JOIN service.locations l ON l.id = j.location_id
       WHERE j.status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM service.dispatches d
                         WHERE d.job_id = j.id AND d.status NOT IN ('complete','cancelled'))
       ORDER BY j.priority = 'emergency' DESC, j.created_at LIMIT 50`),
  ]);
  res.json({ date, techs: techs.rows, dispatches: dispatches.rows, unscheduled: unscheduled.rows });
});

// "My day" for the tech PWA.
router.get('/mine', async (req: AuthRequest, res) => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));
  const { rows } = await pool.query(
    `SELECT d.*, j.number AS job_number, j.type AS job_type, j.summary, j.priority,
            c.name AS customer_name, l.id AS location_id, l.name AS location_name,
            l.address1, l.city, l.state, l.zip, l.access_notes, l.phones AS location_phones
     FROM service.dispatches d
     JOIN service.jobs j ON j.id = d.job_id
     LEFT JOIN service.customers c ON c.id = j.customer_id
     LEFT JOIN service.locations l ON l.id = j.location_id
     WHERE d.tech_id = $1 AND d.scheduled_start::date = $2::date AND d.status != 'cancelled'
     ORDER BY d.scheduled_start`, [req.user!.id, date]);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { job_id, tech_id, scheduled_start, scheduled_end } = req.body || {};
  if (!job_id || !scheduled_start) return res.status(400).json({ error: 'job_id and scheduled_start required' });
  const { rows } = await pool.query(
    `INSERT INTO service.dispatches (job_id, tech_id, scheduled_start, scheduled_end)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [job_id, tech_id, scheduled_start, scheduled_end]
  );
  await pool.query(
    `UPDATE service.jobs SET status = 'scheduled' WHERE id = $1 AND status IN ('intake','pending')`, [job_id]);
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req: AuthRequest, res) => {
  const allowed = ['tech_id', 'scheduled_start', 'scheduled_end', 'status', 'time_in', 'time_out', 'signature', 'photos'];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const k of allowed) {
    if (k in (req.body || {})) {
      params.push(k === 'photos' ? JSON.stringify(req.body[k]) : req.body[k]);
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE service.dispatches SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'Dispatch not found' });
  // Keep the parent job's status in step with field progress.
  if (req.body.status === 'onsite' || req.body.status === 'enroute') {
    await pool.query(`UPDATE service.jobs SET status = 'in_progress' WHERE id = $1`, [rows[0].job_id]);
  }
  res.json(rows[0]);
});

export default router;
