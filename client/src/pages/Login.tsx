import { useState } from "react";
import { useLocation, Link } from "wouter";
import { Sparkles, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import AuthLayout, {
  AuthCard,
  AUTH_INPUT_CLS,
  AUTH_LABEL_CLS,
  GoogleG,
} from "@/components/AuthLayout";

/**
 * Login + Sign-up page.
 *
 * Keeps the real dual-mode behaviour (email/password sign-in and
 * registration, optional Google OAuth when enabled) while adopting the
 * redesign prototype's dark foil hero aesthetic.
 */
export default function Login() {
  const [, setLocation] = useLocation();
  const { refresh, googleEnabled } = useAuth();
  const { toast } = useToast();

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [signupSuccess, setSignupSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (mode === "signin") {
        await apiRequest({
          url: "/api/auth/login",
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
        await refresh();
        setLocation("/");
      } else {
        await apiRequest({
          url: "/api/auth/register",
          method: "POST",
          body: JSON.stringify({ email, password, displayName }),
        });
        await refresh();
        setSignupSuccess(true);
      }
    } catch (err: any) {
      const msg = String(err?.message || "Something went wrong").replace(/^\d+:\s*/, "");
      let parsed = msg;
      try { parsed = JSON.parse(msg).error || msg; } catch {}
      toast({
        title: mode === "signin" ? "Sign-in failed" : "Sign-up failed",
        description: parsed,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (signupSuccess) {
    return (
      <AuthLayout>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/10 ring-1 ring-white/20 text-[11px] uppercase tracking-[0.14em] w-fit">
          <Sparkles className="w-3 h-3 text-foil-gold" />
          You're in
        </span>
        <h1 className="font-display text-[32px] leading-[1.1] font-semibold tracking-tight mt-3">
          Check your email
        </h1>
        <p className="text-white/70 text-[15px] leading-relaxed mt-3">
          We sent a verification link to <span className="text-white font-medium">{email}</span>.
          Click the link to verify your address — you can keep using PackScan in the meantime.
        </p>
        <button
          onClick={() => setLocation("/")}
          className="mt-6 w-full h-12 rounded-xl bg-foil-violet text-white font-medium text-sm hover-elevate"
          data-testid="button-continue"
        >
          Continue to PackScan
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/10 ring-1 ring-white/20 text-[11px] uppercase tracking-[0.14em] w-fit">
        <Sparkles className="w-3 h-3 text-foil-gold" /> Holo grading inside
      </span>
      <h1 className="font-display text-[32px] sm:text-[36px] leading-[1.05] font-semibold tracking-tight mt-3">
        {mode === "signin" ? (
          <>
            Welcome back to
            <br />
            <span
              className="text-foil bg-clip-text text-transparent"
              style={{ backgroundImage: "var(--grad-foil)" }}
            >
              PackScan
            </span>
          </>
        ) : (
          <>
            Scan any card.
            <br />
            <span
              className="text-foil bg-clip-text text-transparent"
              style={{ backgroundImage: "var(--grad-foil)" }}
            >
              Know what it's worth.
            </span>
          </>
        )}
      </h1>
      <p className="text-white/70 text-[15px] leading-relaxed mt-3">
        {mode === "signin"
          ? "Sign in to access your collection and sync to Google Sheets."
          : "Grade, identify, and price every card. Back up to your own Google Sheet — you own your data."}
      </p>

      {googleEnabled && (
        <>
          <a href="/api/auth/google" className="block mt-6" data-testid="link-google">
            <button
              type="button"
              className="w-full h-12 rounded-xl bg-white text-[#1f2937] font-medium text-sm flex items-center justify-center gap-3 hover-elevate"
            >
              <GoogleG />
              Continue with Google
            </button>
          </a>
          <div className="mt-4 flex items-center gap-3">
            <span className="flex-1 h-px bg-white/15" />
            <span className="text-[11px] text-white/40 uppercase tracking-[0.14em]">Or</span>
            <span className="flex-1 h-px bg-white/15" />
          </div>
        </>
      )}

      <AuthCard>
        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === "signup" && (
            <div>
              <label htmlFor="displayName" className={AUTH_LABEL_CLS}>
                Name
              </label>
              <input
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className={AUTH_INPUT_CLS}
                data-testid="input-name"
              />
            </div>
          )}
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
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <label htmlFor="password" className={AUTH_LABEL_CLS + " mb-0"}>
                Password
              </label>
              {mode === "signin" && (
                <Link
                  href="/forgot-password"
                  className="text-[11px] text-white/60 hover:text-white"
                  data-testid="link-forgot"
                >
                  Forgot?
                </Link>
              )}
            </div>
            <input
              id="password"
              type="password"
              required
              minLength={mode === "signup" ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "signup" ? "At least 8 characters" : "••••••••"}
              className={AUTH_INPUT_CLS}
              data-testid="input-password"
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
                Working…
              </>
            ) : mode === "signin" ? (
              "Sign in"
            ) : (
              "Create account"
            )}
          </button>
        </form>
      </AuthCard>

      <button
        type="button"
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        className="mt-5 text-center w-full text-sm text-white/70 hover:text-white"
        data-testid="button-toggle-mode"
      >
        {mode === "signin" ? (
          <>Need an account? <span className="text-white font-medium">Sign up</span></>
        ) : (
          <>Already have an account? <span className="text-white font-medium">Sign in</span></>
        )}
      </button>
    </AuthLayout>
  );
}
