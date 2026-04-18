import { useState } from "react";
import { useLocation, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { SiGoogle } from "react-icons/si";

export default function Login() {
  const [, setLocation] = useLocation();
  const { refresh, googleEnabled } = useAuth();
  const { toast } = useToast();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [signupSuccess, setSignupSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (mode === 'signin') {
        await apiRequest({ url: '/api/auth/login', method: 'POST', body: JSON.stringify({ email, password }) });
        await refresh();
        setLocation('/');
      } else {
        await apiRequest({ url: '/api/auth/register', method: 'POST', body: JSON.stringify({ email, password, displayName }) });
        await refresh();
        setSignupSuccess(true);
      }
    } catch (err: any) {
      const msg = String(err?.message || 'Something went wrong').replace(/^\d+:\s*/, '');
      let parsed = msg;
      try { parsed = JSON.parse(msg).error || msg; } catch {}
      toast({ title: mode === 'signin' ? 'Sign-in failed' : 'Sign-up failed', description: parsed, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  if (signupSuccess) {
    return (
      <div className="p-4 max-w-md mx-auto">
        <Card>
          <CardHeader><CardTitle>Check your email</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-slate-700">
              We sent a verification link to <strong>{email}</strong>. Click the link to verify your address.
              You can keep using PackScan in the meantime.
            </p>
            <Button onClick={() => setLocation('/')} className="w-full">Continue to PackScan</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-md mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>{mode === 'signin' ? 'Sign in to PackScan' : 'Create your PackScan account'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {googleEnabled && (
            <>
              <a href="/api/auth/google" className="block">
                <Button type="button" variant="outline" className="w-full flex items-center gap-2">
                  <SiGoogle className="h-4 w-4" />
                  Continue with Google
                </Button>
              </a>
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <div className="flex-1 h-px bg-slate-200" /> or <div className="flex-1 h-px bg-slate-200" />
              </div>
            </>
          )}
          <form onSubmit={handleSubmit} className="space-y-3">
            {mode === 'signup' && (
              <div>
                <Label htmlFor="displayName">Name</Label>
                <Input id="displayName" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Your name" />
              </div>
            )}
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required minLength={mode === 'signup' ? 8 : undefined} value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? 'Working…' : (mode === 'signin' ? 'Sign in' : 'Create account')}
            </Button>
          </form>
          <div className="flex items-center justify-between text-sm">
            <button onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')} className="text-blue-600 hover:underline" type="button">
              {mode === 'signin' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
            </button>
            {mode === 'signin' && (
              <Link href="/forgot-password" className="text-blue-600 hover:underline">Forgot password?</Link>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
