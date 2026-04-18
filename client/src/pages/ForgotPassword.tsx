import { useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiRequest({ url: '/api/auth/forgot-password', method: 'POST', body: JSON.stringify({ email }) });
      setDone(true);
    } finally { setSubmitting(false); }
  };

  return (
    <div className="p-4 max-w-md mx-auto">
      <Card>
        <CardHeader><CardTitle>Forgot your password?</CardTitle></CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-3">
              <p className="text-sm text-slate-700">If an account exists for <strong>{email}</strong>, we've sent a password reset link. The link expires in 1 hour.</p>
              <Link href="/login" className="text-blue-600 hover:underline text-sm">Back to sign in</Link>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <p className="text-sm text-slate-600">Enter your email and we'll send you a reset link.</p>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" required value={email} onChange={e => setEmail(e.target.value)} />
              </div>
              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? 'Sending…' : 'Send reset link'}
              </Button>
              <Link href="/login" className="text-blue-600 hover:underline text-sm block text-center">Back to sign in</Link>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
