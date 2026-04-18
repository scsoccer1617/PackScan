import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";

export default function AccountSettings() {
  const { user, refresh } = useAuth();
  const { toast } = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiRequest({ url: '/api/auth/change-password', method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
      toast({ title: 'Password updated' });
      setCurrentPassword(''); setNewPassword('');
    } catch (err: any) {
      const msg = String(err?.message || '').replace(/^\d+:\s*/, '');
      let parsed = msg; try { parsed = JSON.parse(msg).error || msg; } catch {}
      toast({ title: 'Update failed', description: parsed, variant: 'destructive' });
    } finally { setSubmitting(false); }
  };

  if (!user) return <div className="p-4 text-sm">Please sign in.</div>;
  const hasPassword = user.email && !user.googleId; // best-effort hint
  return (
    <div className="p-4 space-y-4 max-w-md mx-auto">
      <h1 className="text-2xl font-semibold">Account settings</h1>
      <Card>
        <CardHeader><CardTitle className="text-base">Profile</CardTitle></CardHeader>
        <CardContent>
          <div className="text-sm space-y-1">
            <div><span className="text-slate-500">Name:</span> {user.displayName || '—'}</div>
            <div><span className="text-slate-500">Email:</span> {user.email || '—'}</div>
            <div><span className="text-slate-500">Google:</span> {user.googleConnected ? 'Connected' : 'Not connected'}</div>
          </div>
          {!user.googleConnected && (
            <a href="/api/auth/google/connect"><Button size="sm" className="mt-3">Connect Google</Button></a>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Change password</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <div>
              <Label htmlFor="currentPassword">Current password {!hasPassword && <span className="text-xs text-slate-500">(leave blank if none)</span>}</Label>
              <Input id="currentPassword" type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="newPassword">New password</Label>
              <Input id="newPassword" type="password" required minLength={8} value={newPassword} onChange={e => setNewPassword(e.target.value)} />
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
