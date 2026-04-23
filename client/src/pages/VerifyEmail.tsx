import { useEffect, useState } from "react";
import { Link } from "wouter";
import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import AuthLayout from "@/components/AuthLayout";

export default function VerifyEmail() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") || "";
  const { refresh } = useAuth();
  const [status, setStatus] = useState<"verifying" | "ok" | "error">("verifying");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setErrorMsg("Missing verification token.");
      return;
    }
    apiRequest({
      url: "/api/auth/verify-email",
      method: "POST",
      body: JSON.stringify({ token }),
    })
      .then(async () => {
        await refresh();
        setStatus("ok");
      })
      .catch((err: any) => {
        const msg = String(err?.message || "").replace(/^\d+:\s*/, "");
        let parsed = msg;
        try { parsed = JSON.parse(msg).error || msg; } catch {}
        setErrorMsg(parsed);
        setStatus("error");
      });
  }, [token, refresh]);

  return (
    <AuthLayout>
      {status === "verifying" && (
        <>
          <div className="w-14 h-14 rounded-2xl bg-white/10 flex items-center justify-center text-white/80 mb-4">
            <Loader2 className="w-7 h-7 animate-spin" />
          </div>
          <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">
            Verifying your email…
          </h1>
          <p className="text-white/70 text-[15px] leading-relaxed mt-2">
            Hang on a second — this usually takes a moment.
          </p>
        </>
      )}

      {status === "ok" && (
        <>
          <div className="w-14 h-14 rounded-2xl bg-foil-green/15 flex items-center justify-center text-foil-green mb-4">
            <CheckCircle2 className="w-7 h-7" />
          </div>
          <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">
            Email verified
          </h1>
          <p className="text-white/70 text-[15px] leading-relaxed mt-2">
            Your email address is confirmed. You're all set to keep scanning and syncing.
          </p>
          <Link
            href="/"
            className="mt-6 w-full h-12 rounded-xl bg-foil-violet text-white font-medium text-sm flex items-center justify-center hover-elevate"
            data-testid="link-continue"
          >
            Continue to PackScan
          </Link>
        </>
      )}

      {status === "error" && (
        <>
          <div className="w-14 h-14 rounded-2xl bg-foil-amber/15 flex items-center justify-center text-foil-amber mb-4">
            <AlertTriangle className="w-7 h-7" />
          </div>
          <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">
            Verification failed
          </h1>
          <p className="text-white/70 text-[15px] leading-relaxed mt-2">
            {errorMsg || "We couldn't verify this link. It may have expired."}
          </p>
          <Link
            href="/"
            className="mt-6 w-full h-12 rounded-xl bg-foil-violet text-white font-medium text-sm flex items-center justify-center hover-elevate"
            data-testid="link-home"
          >
            Back to home
          </Link>
        </>
      )}
    </AuthLayout>
  );
}
