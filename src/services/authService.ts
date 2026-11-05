import { supabase, isSupabaseConfigured, getSupabaseEdgeFunctionUrl } from '../supabase';

export interface AuthUser {
  id: string;
  username: string;
  gems: number;
  inventory: Record<string, number>;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  token_type?: string;
  user?: {
    id: string;
    email?: string;
  };
}

export interface RegisterResult {
  success: boolean;
  user: AuthUser;
  session: AuthSession;
  recoveryCode: string;
}

export interface LoginResult {
  success: boolean;
  user: AuthUser;
  session: AuthSession;
}

function getRequestHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const key =
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (key) {
    headers['apikey'] = key;
    headers['Authorization'] = `Bearer ${key}`;
  }
  return headers;
}

export async function registerPlayer(
  username: string,
  password: string,
  confirmPassword: string
): Promise<RegisterResult> {
  const clean = username.trim();
  if (!clean || clean.length < 3 || clean.length > 16 || !/^[a-zA-Z0-9_-]+$/.test(clean)) {
    throw new Error('Username must be 3-16 alphanumeric characters, hyphens, or underscores.');
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }
  if (password !== confirmPassword) {
    throw new Error('Passwords do not match.');
  }

  const url = getSupabaseEdgeFunctionUrl('register-player');
  const res = await fetch(url, {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({
      username: clean,
      password,
      confirmPassword,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Registration failed.');
  }

  // Update Supabase client session if remote Supabase is configured and tokens are returned
  if (isSupabaseConfigured && data.session?.access_token && data.session?.refresh_token) {
    try {
      await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
    } catch (e) {
      console.warn('Could not set Supabase client session:', e);
    }
  }

  return {
    success: true,
    user: {
      id: data.user?.id || 'p_' + Math.random().toString(36).substring(2, 9),
      username: data.user?.username || clean,
      gems: data.user?.gems ?? 0,
      inventory: data.user?.inventory || {},
    },
    session: data.session,
    recoveryCode: data.recoveryCode || '',
  };
}

export async function loginPlayer(
  username: string,
  password: string
): Promise<LoginResult> {
  const clean = username.trim();
  if (!clean) {
    throw new Error('Please enter your username.');
  }
  if (!password) {
    throw new Error('Please enter your password.');
  }

  const url = getSupabaseEdgeFunctionUrl('login-player');
  const res = await fetch(url, {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({
      username: clean,
      password,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Invalid username or password.');
  }

  // Update Supabase client session if remote Supabase is configured and tokens are returned
  if (isSupabaseConfigured && data.session?.access_token && data.session?.refresh_token) {
    try {
      await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
    } catch (e) {
      console.warn('Could not set Supabase client session:', e);
    }
  }

  return {
    success: true,
    user: {
      id: data.user?.id || 'p_' + Math.random().toString(36).substring(2, 9),
      username: data.user?.username || clean,
      gems: data.user?.gems ?? 0,
      inventory: data.user?.inventory || {},
    },
    session: data.session,
  };
}

export async function logoutPlayer(): Promise<void> {
  if (isSupabaseConfigured) {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn('Supabase signout warning:', e);
    }
  }
  localStorage.removeItem('growpixel_mmo_user');
}

export async function recoverAccount(
  recoveryCode: string,
  newPassword: string
): Promise<{ success: boolean; message: string }> {
  const cleanCode = recoveryCode.trim();
  if (!cleanCode) {
    throw new Error('Please enter your recovery code.');
  }
  if (!newPassword || newPassword.length < 8) {
    throw new Error('New password must be at least 8 characters long.');
  }

  const url = getSupabaseEdgeFunctionUrl('recover-player');
  const res = await fetch(url, {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({
      recoveryCode: cleanCode,
      newPassword,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Recovery failed.');
  }

  return {
    success: true,
    message: data.message || 'Password successfully reset.',
  };
}
