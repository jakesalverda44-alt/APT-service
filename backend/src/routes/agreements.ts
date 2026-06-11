import { Router } from 'express';
import { pool } from '../db';
import { requireAuth } from '../auth';

const router = Router();
router.use(requireAuth);

// Agreement List grid (ESC columns: customer, agreement #, type, dates, location).
router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const params: unknown[] = [];
  let where = '';
  if (q) {
    params.push(`%${q}%`);
    where = `WHERE c.name ILIKE $1 OR a.esc_agreement_no LIKE $1 OR a.type_code ILIKE $1 OR l.name ILIKE $1`;
  }
  const { rows } = await pool.query(
    `SELECT a.id, a.esc_agreement_no, a.type_code, a.plan_name, a.status,
            a.original_contract_date, a.last_renewal_date, a.expires_on,
            a.visits_major_remaining, a.visits_minor_remaining,
            c.name AS customer_name, c.esc_account_no, l.name AS location_name, l.address1
     FROM service.agreements a
     JOIN service.customers c ON c.id = a.customer_id
     LEFT JOIN service.locations l ON l.id = a.location_id
     ${where}
     ORDER BY c.name LIMIT 300`, params);
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

export default router;
