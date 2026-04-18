import { useState } from "react";
import { useLocation, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiRequest({ url: '/api/auth/reset-password', method: 'POST', body: JSON.stringify({ token, password }) });
      toast({ title: 'Password updated', description: 'You can now sign in with your new password.' });
      setLocation('/login');
    } catch (err: any) {
      const msg = String(err?.message || '').replace(/^\d+:\s*/, '');
      let parsed = msg; try { parsed = JSON.parse(msg).error || msg; } catch {}
      toast({ title: 'Reset failed', description: parsed, variant: 'destructive' });
    } finally { setSubmitting(false); }
  };

  if (!token) {
    return (
      <div className="p-4 max-w-md mx-auto">
        <Card><CardHeader><CardTitle>Invalid link</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-slate-700">This reset link is missing a token.</p>
            <Link href="/forgot-password" className="text-blue-600 hover:underline text-sm">Request a new one</Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-md mx-auto">
      <Card>
        <CardHeader><CardTitle>Set a new password</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <div>
              <Label htmlFor="password">New password</Label>
              <Input id="password" type="password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? 'Saving…' : 'Update password'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
