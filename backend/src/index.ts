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
  app.listen(port, () => console.log(`apt-service backend on :${port}`));
}

start().catch((err) => {
  console.error('startup failed:', err);
  process.exit(1);
});
