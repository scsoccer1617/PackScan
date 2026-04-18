import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";

export default function VerifyEmail() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const { refresh } = useAuth();
  const [status, setStatus] = useState<'verifying' | 'ok' | 'error'>('verifying');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!token) { setStatus('error'); setErrorMsg('Missing verification token.'); return; }
    apiRequest({ url: '/api/auth/verify-email', method: 'POST', body: JSON.stringify({ token }) })
      .then(async () => { await refresh(); setStatus('ok'); })
      .catch((err: any) => {
        const msg = String(err?.message || '').replace(/^\d+:\s*/, '');
        let parsed = msg; try { parsed = JSON.parse(msg).error || msg; } catch {}
        setErrorMsg(parsed); setStatus('error');
      });
  }, [token, refresh]);

  return (
    <div className="p-4 max-w-md mx-auto">
      <Card>
        <CardHeader><CardTitle>Email verification</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {status === 'verifying' && <p className="text-sm text-slate-700">Verifying your email…</p>}
          {status === 'ok' && (
            <>
              <p className="text-sm text-green-700">Your email has been verified.</p>
              <Link href="/" className="text-blue-600 hover:underline text-sm">Continue to PackScan</Link>
            </>
          )}
          {status === 'error' && (
            <>
              <p className="text-sm text-red-600">{errorMsg || 'Verification failed.'}</p>
              <Link href="/" className="text-blue-600 hover:underline text-sm">Back to home</Link>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
