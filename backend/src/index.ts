import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import authRoutes from './routes/auth';
import customerRoutes from './routes/customers';
import jobRoutes from './routes/jobs';
import dispatchRoutes from './routes/dispatches';
import agreementRoutes from './routes/agreements';
import intakeRoutes from './routes/intake';
import importRoutes from './routes/import';
import invoiceRoutes from './routes/invoices';

dotenv.config();

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'apt-service' }));
app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/dispatches', dispatchRoutes);
app.use('/api/agreements', agreementRoutes);
app.use('/api/intake', intakeRoutes);
app.use('/api/import', importRoutes);
app.use('/api/invoices', invoiceRoutes);

// In production the built frontend is served from the same process.
const frontendDist = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(frontendDist, 'index.html')));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

const port = Number(process.env.PORT) || 5100;

async function start() {
  if (process.env.AUTO_MIGRATE !== 'false') {
    const { runMigrations } = await import('./migrate');
    await runMigrations();
  }
  // PM scheduler: generate upcoming preventive-maintenance jobs on boot and
  // twice a day thereafter (also runnable on demand from the Agreements page).
  if (process.env.DISABLE_PM_CRON !== 'true') {
    const { generatePmJobs } = await import('./pm');
    const run = () =>
      generatePmJobs()
        .then((n) => n && console.log(`pm scheduler: created ${n} job(s)`))
        .catch((err) => console.error('pm scheduler failed:', err));
    run();
    setInterval(run, 12 * 60 * 60 * 1000);
  }
  app.listen(port, () => console.log(`apt-service backend on :${port}`));
}

start().catch((err) => {
  console.error('startup failed:', err);
  process.exit(1);
});
