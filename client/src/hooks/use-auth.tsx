import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { apiRequest } from "@/lib/queryClient";

export interface AuthUser {
  id: number;
  email: string | null;
  displayName: string | null;
  emailVerifiedAt: string | null;
  googleId: string | null;
  googleConnected: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  googleEnabled: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null, loading: true, googleEnabled: false,
  refresh: async () => {}, logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.status === 401) { setUser(null); }
      else if (res.ok) {
        const data = await res.json();
        setUser(data.user || null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    fetch('/api/auth/config').then(r => r.json()).then(d => setGoogleEnabled(!!d.googleEnabled)).catch(() => {});
  }, [refresh]);

  const logout = useCallback(async () => {
    await apiRequest({ url: '/api/auth/logout', method: 'POST' });
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, googleEnabled, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
