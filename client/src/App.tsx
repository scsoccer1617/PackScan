import { Switch, Route, useLocation, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import PriceLookup from "@/pages/PriceLookup";
import CardSearch from "@/pages/CardSearch";
import CardDatabaseAdmin from "@/pages/CardDatabaseAdmin";
import Login from "@/pages/Login";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
import VerifyEmail from "@/pages/VerifyEmail";
import MySheets from "@/pages/MySheets";
import AccountSettings from "@/pages/AccountSettings";
import Collection from "@/pages/Collection";
import Stats from "@/pages/Stats";
import AppShell from "@/components/AppShell";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const PUBLIC_ROUTES = new Set([
  "/login",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
]);

function VerificationBanner() {
  const { user, refresh } = useAuth();
  const { toast } = useToast();
  const [dismissed, setDismissed] = useState(false);
  const [resending, setResending] = useState(false);
  if (!user || user.emailVerifiedAt || !user.email || dismissed) return null;
  const resend = async () => {
    setResending(true);
    try {
      await apiRequest({ url: "/api/auth/resend-verification", method: "POST" });
      toast({ title: "Verification email sent", description: `Check ${user.email}.` });
      await refresh();
    } catch {
      toast({ title: "Could not resend email", variant: "destructive" });
    } finally {
      setResending(false);
    }
  };
  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm flex items-center gap-2 flex-wrap">
      <span className="text-amber-800">Please verify your email address.</span>
      <Button size="sm" variant="outline" onClick={resend} disabled={resending}>
        {resending ? "Sending…" : "Resend verification"}
      </Button>
      <button
        onClick={() => setDismissed(true)}
        className="text-amber-700 text-xs ml-auto"
      >
        Dismiss
      </button>
    </div>
  );
}

function isPublicLocation(location: string) {
  return (
    PUBLIC_ROUTES.has(location) ||
    location.startsWith("/reset-password") ||
    location.startsWith("/verify-email")
  );
}

/**
 * Redesign shell: Public routes (login, etc.) render bare — they own their
 * own page layout. Authenticated routes render inside AppShell which
 * provides the sticky TopBar and 5-tab BottomTabs chrome.
 */
function Router() {
  const { user, loading } = useAuth();
  const [location] = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }

  const isPublic = isPublicLocation(location);

  // Public routes (no auth required, no shell chrome)
  if (isPublic) {
    return (
      <Switch>
        <Route path="/login" component={() => (user ? <Redirect to="/" /> : <Login />)} />
        <Route path="/forgot-password" component={ForgotPassword} />
        <Route path="/reset-password" component={ResetPassword} />
        <Route path="/verify-email" component={VerifyEmail} />
      </Switch>
    );
  }

  // Require auth for everything else
  if (!user) {
    return <Redirect to="/login" />;
  }

  // Authenticated routes — wrapped in new shell
  return (
    <AppShell>
      <VerificationBanner />
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/scan" component={PriceLookup} />
        <Route path="/search" component={CardSearch} />
        <Route path="/collection" component={Collection} />
        <Route path="/sheets" component={MySheets} />
        <Route path="/stats" component={Stats} />
        <Route path="/account" component={AccountSettings} />
        <Route path="/admin/card-database" component={CardDatabaseAdmin} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Router />
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
