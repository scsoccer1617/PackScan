import Logo from "@/components/Logo";
import { Link } from "wouter";

/**
 * Shared chrome for every auth page (Login, Signup, ForgotPassword,
 * ResetPassword, VerifyEmail). Dark `bg-pack` gradient background with
 * foil radial glows, centered brand row at top, centered content card
 * in the middle, terms/privacy fine print at the bottom.
 *
 * Matches the redesign prototype's Login page aesthetic but works on
 * phones of any height (flex column, content can overflow scroll).
 */
export default function AuthLayout({
  children,
  footer,
}: {
  children: React.ReactNode;
  /** Optional override of the bottom fine-print row. */
  footer?: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-pack text-white relative overflow-hidden flex flex-col">
      {/* Ambient foil glow */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle at 15% 10%, rgba(139,92,246,0.45), transparent 50%), radial-gradient(circle at 100% 95%, rgba(34,211,238,0.28), transparent 55%), radial-gradient(circle at 50% 50%, rgba(251,191,36,0.08), transparent 60%)",
        }}
      />

      {/* Top brand row */}
      <div className="relative pt-8 px-6 flex items-center gap-2">
        <Link href="/" className="flex items-center gap-2" aria-label="PackScan home">
          <Logo className="w-9 h-9" tile />
          <p className="font-display text-lg font-semibold tracking-tight">PackScan</p>
        </Link>
      </div>

      {/* Content */}
      <div className="relative flex-1 flex flex-col justify-center px-6 py-8 max-w-md mx-auto w-full">
        {children}
      </div>

      {/* Fine print */}
      <div className="relative px-6 pb-8 max-w-md mx-auto w-full">
        {footer ?? (
          <p className="text-[11px] text-white/40 text-center">
            By continuing you agree to our Terms & Privacy. We only request read/write access to sheets you create.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Dark-card wrapper for auth forms. Use inside AuthLayout. Matches the
 * inner card rhythm of the prototype (translucent, ring-1 white/10).
 */
export function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white/5 ring-1 ring-white/10 backdrop-blur-sm p-5 space-y-4">
      {children}
    </div>
  );
}

export const AUTH_INPUT_CLS =
  "w-full h-12 rounded-xl bg-white/5 border border-white/15 px-3 text-sm text-white placeholder:text-white/40 outline-none focus:ring-2 focus:ring-foil-violet/50 focus:border-transparent";

export const AUTH_LABEL_CLS =
  "block text-[11px] text-white/60 uppercase tracking-wide mb-1";

/** Google G logo used across auth screens. */
export function GoogleG({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
