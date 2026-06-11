import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

// Same shared database as the CRM. The service program reads the CRM's
// public.* tables but writes only to the service schema.
export const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        // Supabase requires SSL; local dev databases don't speak it.
        ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'electrical_crm',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASS || 'postgres',
      }
);
