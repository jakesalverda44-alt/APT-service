import { Router } from 'express';
import { pool } from '../db';
import { requireAuth, requireOffice, AuthRequest } from '../auth';

const router = Router();
router.use(requireAuth, requireOffice);

// Awarded CRM projects waiting to become service jobs.
router.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, crm_project_id, source_type, payload, received_at
     FROM service.project_intake
     WHERE processed_at IS NULL
     ORDER BY received_at DESC`);
  res.json(rows);
});

// Accept: create a service job from the awarded project. For generator jobs
// the proposal's customer/equipment details ride along in the payload and the
// job summary; full equipment records get created when the install completes.
router.post('/:id/accept', async (req: AuthRequest, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const intake = (await client.query(
      'SELECT * FROM service.project_intake WHERE id = $1 AND processed_at IS NULL FOR UPDATE',
      [req.params.id])).rows[0];
    if (!intake) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Intake item not found or already processed' });
    }
    const p = intake.payload || {};
    const summary = [
      p.name || `CRM ${intake.source_type === 'gen' ? 'generator' : 'electrical'} project`,
      p.contract_value ? `$${Number(p.contract_value).toLocaleString()}` : null,
    ].filter(Boolean).join(' — ');

    const job = (await client.query(
      `INSERT INTO service.jobs (crm_project_id, type, status, summary, customer_id, location_id, created_by)
       VALUES ($1, 'project', 'pending', $2, $3, $4, $5) RETURNING *`,
      [intake.crm_project_id, summary,
       req.body?.customer_id || null, req.body?.location_id || null, req.user!.id])).rows[0];

    await client.query(
      'UPDATE service.project_intake SET processed_at = now(), job_id = $1 WHERE id = $2',
      [job.id, intake.id]);
    await client.query('COMMIT');
    res.status(201).json(job);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Dismiss without creating a job (e.g. pure construction work with no service
// component). Kept in the table with processed_at set, so nothing re-queues.
router.post('/:id/dismiss', async (req, res) => {
  const { rowCount } = await pool.query(
    'UPDATE service.project_intake SET processed_at = now() WHERE id = $1 AND processed_at IS NULL',
    [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Intake item not found or already processed' });
  res.json({ ok: true });
});

export default router;
