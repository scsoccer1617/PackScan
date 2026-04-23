import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Mail, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import AuthLayout, {
  AuthCard,
  AUTH_INPUT_CLS,
  AUTH_LABEL_CLS,
} from "@/components/AuthLayout";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiRequest({
        url: "/api/auth/forgot-password",
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setDone(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <AuthLayout>
        <div className="w-14 h-14 rounded-2xl bg-foil-green/15 flex items-center justify-center text-foil-green mb-4">
          <Mail className="w-7 h-7" />
        </div>
        <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">
          Check your inbox
        </h1>
        <p className="text-white/70 text-[15px] leading-relaxed mt-3">
          If an account exists for <span className="text-white font-medium">{email}</span>, we've sent
          a password reset link. The link expires in 1 hour.
        </p>
        <Link
          href="/login"
          className="mt-6 w-full h-12 rounded-xl bg-foil-violet text-white font-medium text-sm flex items-center justify-center hover-elevate"
          data-testid="link-back-to-signin"
        >
          Back to sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <Link
        href="/login"
        className="inline-flex items-center gap-1 text-white/60 hover:text-white text-sm mb-4 w-fit"
        data-testid="link-back"
      >
        <ArrowLeft className="w-4 h-4" /> Back
      </Link>
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">
        Forgot your password?
      </h1>
      <p className="text-white/70 text-[15px] leading-relaxed mt-2">
        Enter the email on your account and we'll send you a reset link.
      </p>

      <AuthCard>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="email" className={AUTH_LABEL_CLS}>
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={AUTH_INPUT_CLS}
              data-testid="input-email"
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
                Sending…
              </>
            ) : (
              "Send reset link"
            )}
          </button>
        </form>
      </AuthCard>
    </AuthLayout>
  );
}
