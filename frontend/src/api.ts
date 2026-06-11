const TOKEN_KEY = 'apt_service_token';
const USER_KEY = 'apt_service_user';

export interface User { id: string; name: string; email: string; role: string }

export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  get user(): User | null {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  },
  set(token: string, user: User) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    auth.clear();
    window.location.href = '/login';
    throw new Error('Not authenticated');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  return body as T;
}

export const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—');
export const fmtTime = (d?: string | null) =>
  d ? new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
