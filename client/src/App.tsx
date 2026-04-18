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
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const PUBLIC_ROUTES = new Set(["/login", "/forgot-password", "/reset-password", "/verify-email"]);

function VerificationBanner() {
  const { user, refresh } = useAuth();
  const { toast } = useToast();
  const [dismissed, setDismissed] = useState(false);
  const [resending, setResending] = useState(false);
  if (!user || user.emailVerifiedAt || !user.email || dismissed) return null;
  const resend = async () => {
    setResending(true);
    try {
      await apiRequest({ url: '/api/auth/resend-verification', method: 'POST' });
      toast({ title: 'Verification email sent', description: `Check ${user.email}.` });
      await refresh();
    } catch {
      toast({ title: 'Could not resend email', variant: 'destructive' });
    } finally { setResending(false); }
  };
  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm flex items-center gap-2 flex-wrap">
      <span className="text-amber-800">Please verify your email address.</span>
      <Button size="sm" variant="outline" onClick={resend} disabled={resending}>
        {resending ? 'Sending…' : 'Resend verification'}
      </Button>
      <button onClick={() => setDismissed(true)} className="text-amber-700 text-xs ml-auto">Dismiss</button>
    </div>
  );
}

function Gate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [location] = useLocation();
  const isPublic = PUBLIC_ROUTES.has(location) || location.startsWith('/reset-password') || location.startsWith('/verify-email');
  if (loading) {
    return <div className="p-8 text-center text-sm text-slate-500">Loading…</div>;
  }
  if (!user && !isPublic) {
    return <Redirect to="/login" />;
  }
  if (user && location === '/login') {
    return <Redirect to="/" />;
  }
  return <>{children}</>;
}

function AppShell() {
  return (
    <div className="max-w-lg mx-auto min-h-screen flex flex-col bg-white relative">
      <Header />
      <VerificationBanner />
      <main className="flex-1 overflow-y-auto pb-4">
        <Gate>
          <Switch>
            <Route path="/" component={() => <Home />} />
            <Route path="/scan" component={() => <PriceLookup />} />
            <Route path="/search" component={() => <CardSearch />} />
            <Route path="/admin/card-database" component={() => <CardDatabaseAdmin />} />
            <Route path="/login" component={() => <Login />} />
            <Route path="/forgot-password" component={() => <ForgotPassword />} />
            <Route path="/reset-password" component={() => <ResetPassword />} />
            <Route path="/verify-email" component={() => <VerifyEmail />} />
            <Route path="/sheets" component={() => <MySheets />} />
            <Route path="/account" component={() => <AccountSettings />} />
            <Route component={NotFound} />
          </Switch>
        </Gate>
      </main>
      <Footer />
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
