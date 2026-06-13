import { Router } from 'express';
import { pool } from '../db';
import { requireAuth, requireOffice } from '../auth';

const router = Router();
router.use(requireAuth, requireOffice);

// The handful of reports the office actually pulled from ESC, computed live.
router.get('/summary', async (_req, res) => {
  const [ar, arTotals, renewals, renewCounts, pmDue, techs, jobStatus] = await Promise.all([
    // AR aging by customer (open ESC-history invoices + open in-app invoices)
    pool.query(`
      WITH open_items AS (
        SELECT customer_id, inv_date AS d, amount - paid AS bal
        FROM service.invoice_history WHERE amount > paid
        UNION ALL
        SELECT customer_id, issued_on AS d, balance_due AS bal
        FROM service.invoices WHERE status NOT IN ('paid','void') AND balance_due > 0
      )
      SELECT c.id, c.name, c.esc_account_no,
             SUM(bal)::numeric(12,2) AS balance,
             SUM(bal) FILTER (WHERE d >  CURRENT_DATE - 30)::numeric(12,2) AS current,
             SUM(bal) FILTER (WHERE d <= CURRENT_DATE - 30 AND d > CURRENT_DATE - 60)::numeric(12,2) AS over30,
             SUM(bal) FILTER (WHERE d <= CURRENT_DATE - 60 AND d > CURRENT_DATE - 90)::numeric(12,2) AS over60,
             SUM(bal) FILTER (WHERE d <= CURRENT_DATE - 90)::numeric(12,2) AS over90
      FROM open_items o JOIN service.customers c ON c.id = o.customer_id
      GROUP BY c.id, c.name, c.esc_account_no
      ORDER BY SUM(bal) DESC LIMIT 50`),
    pool.query(`
      SELECT COALESCE(SUM(amount - paid),0)::numeric(14,2) AS history_open,
             (SELECT COALESCE(SUM(balance_due),0)::numeric(14,2) FROM service.invoices
              WHERE status NOT IN ('paid','void')) AS app_open
      FROM service.invoice_history WHERE amount > paid`),
    pool.query(`
      SELECT a.id, a.plan_name, a.type_code, a.expires_on, a.price,
             c.name AS customer_name, c.phones AS customer_phones
      FROM service.agreements a JOIN service.customers c ON c.id = a.customer_id
      WHERE a.status = 'active' AND a.expires_on IS NOT NULL
        AND a.expires_on <= CURRENT_DATE + 90
      ORDER BY a.expires_on LIMIT 25`),
    pool.query(`
      SELECT count(*) FILTER (WHERE expires_on <= CURRENT_DATE + 30) AS d30,
             count(*) FILTER (WHERE expires_on <= CURRENT_DATE + 60) AS d60,
             count(*) FILTER (WHERE expires_on <= CURRENT_DATE + 90) AS d90
      FROM service.agreements
      WHERE status = 'active' AND expires_on IS NOT NULL AND expires_on >= CURRENT_DATE - 1`),
    pool.query(`
      SELECT t.name AS task, t.kind, t.next_due_on, a.plan_name, a.type_code,
             c.name AS customer_name, l.name AS location_name
      FROM service.agreement_tasks t
      JOIN service.agreements a ON a.id = t.agreement_id
      JOIN service.customers c ON c.id = a.customer_id
      LEFT JOIN service.locations l ON l.id = a.location_id
      WHERE a.status = 'active' AND t.next_due_on IS NOT NULL
        AND t.next_due_on <= CURRENT_DATE + 30
      ORDER BY t.next_due_on LIMIT 50`),
    pool.query(`
      SELECT u.name AS tech,
             count(*) AS visits,
             count(*) FILTER (WHERE d.status = 'complete') AS completed
      FROM service.dispatches d JOIN public.users u ON u.id = d.tech_id
      WHERE d.scheduled_start >= CURRENT_DATE - 30
      GROUP BY u.name ORDER BY count(*) DESC`),
    pool.query(`SELECT status, count(*) FROM service.jobs GROUP BY status ORDER BY count(*) DESC`),
  ]);
  res.json({
    ar: ar.rows,
    ar_totals: arTotals.rows[0],
    renewals: renewals.rows,
    renewal_counts: renewCounts.rows[0],
    pm_due: pmDue.rows,
    techs_30d: techs.rows,
    job_status: jobStatus.rows,
  });
});

export default router;
