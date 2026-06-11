import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Tokens are interchangeable with the CRM: same shared users table, same
// JWT_SECRET, same payload shape — one login works in both programs.
export const TOKEN_TTL = '12h';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export function getJwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is required (use the same value as the CRM)');
  return s;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(header.slice(7), getJwtSecret()) as AuthUser;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const OFFICE_ROLES = ['owner', 'administrator', 'dispatcher', 'accounting', 'project_manager'];

/** Office staff (full app). Technicians are limited to their own dispatches. */
export function requireOffice(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || !OFFICE_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
}
