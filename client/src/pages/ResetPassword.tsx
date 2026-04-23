import { useState } from "react";
import { useLocation, Link } from "wouter";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import AuthLayout, {
  AuthCard,
  AUTH_INPUT_CLS,
  AUTH_LABEL_CLS,
} from "@/components/AuthLayout";

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") || "";

  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiRequest({
        url: "/api/auth/reset-password",
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      toast({ title: "Password updated", description: "You can now sign in with your new password." });
      setLocation("/login");
    } catch (err: any) {
      const msg = String(err?.message || "").replace(/^\d+:\s*/, "");
      let parsed = msg;
      try { parsed = JSON.parse(msg).error || msg; } catch {}
      toast({ title: "Reset failed", description: parsed, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <AuthLayout>
        <div className="w-14 h-14 rounded-2xl bg-foil-amber/15 flex items-center justify-center text-foil-amber mb-4">
          <AlertTriangle className="w-7 h-7" />
        </div>
        <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">
          Invalid reset link
        </h1>
        <p className="text-white/70 text-[15px] leading-relaxed mt-2">
          This reset link is missing a token or has expired. Request a new one and try again.
        </p>
        <Link
          href="/forgot-password"
          className="mt-6 w-full h-12 rounded-xl bg-foil-violet text-white font-medium text-sm flex items-center justify-center hover-elevate"
          data-testid="link-request-new"
        >
          Request a new link
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">
        Set a new password
      </h1>
      <p className="text-white/70 text-[15px] leading-relaxed mt-2">
        Choose a password with at least 8 characters. You'll use this to sign in from now on.
      </p>

      <AuthCard>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="password" className={AUTH_LABEL_CLS}>
              New password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              className={AUTH_INPUT_CLS}
              data-testid="input-new-password"
              autoFocus
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full h-12 rounded-xl bg-foil-violet text-white font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-60 hover-elevate"
            data-testid="button-submit"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Update password"
            )}
          </button>
        </form>
      </AuthCard>
    </AuthLayout>
  );
}
