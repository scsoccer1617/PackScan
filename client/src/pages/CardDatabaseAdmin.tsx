import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Database, Upload, Trash2, RefreshCw, CheckCircle, AlertCircle, Lock, LogOut } from "lucide-react";

const SESSION_KEY = "admin_session_password";

interface DbStats {
  cards: number;
  variations: number;
}

interface ImportResult {
  success: boolean;
  imported: number;
  replaced: number;
  errors: string[];
  errorCount: number;
  error?: string;
}

// ── Password Gate ────────────────────────────────────────────────────────────

function PasswordGate({ onUnlock }: { onUnlock: (password: string) => void }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    setError("");
    setChecking(true);
    try {
      const res = await fetch("/api/card-database/check-auth", {
        headers: { "x-admin-password": input },
      });
      if (res.ok) {
        sessionStorage.setItem(SESSION_KEY, input);
        onUnlock(input);
      } else if (res.status === 500) {
        setError("Admin password is not configured on this server.");
      } else {
        setError("Incorrect password. Try again.");
      }
    } catch {
      setError("Connection error. Please try again.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[60vh] p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center pb-4">
          <div className="flex justify-center mb-3">
            <div className="bg-slate-100 rounded-full p-3">
              <Lock className="w-6 h-6 text-slate-600" />
            </div>
          </div>
          <CardTitle className="text-lg">Admin Access</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">Enter the admin password to continue</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3">
            <Input
              type="password"
              placeholder="Admin password"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoFocus
              disabled={checking}
            />
            {error && (
              <p className="text-xs text-red-600 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" /> {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={checking || !input.trim()}>
              {checking ? (
                <><RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Checking…</>
              ) : (
                "Unlock"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Admin Panel ──────────────────────────────────────────────────────────────

function AdminPanel({ password, onLock }: { password: string; onLock: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const cardsFileRef = useRef<HTMLInputElement>(null);
  const variationsFileRef = useRef<HTMLInputElement>(null);

  const [cardsResult, setCardsResult] = useState<ImportResult | null>(null);
  const [variationsResult, setVariationsResult] = useState<ImportResult | null>(null);

  const authHeader = { "x-admin-password": password };

  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery<DbStats>({
    queryKey: ["/api/card-database/stats"],
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file, endpoint }: { file: File; endpoint: string }) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(endpoint, {
        method: "POST",
        body: formData,
        headers: authHeader,
      });
      if (res.status === 401) throw new Error("Unauthorized");
      return res.json() as Promise<ImportResult>;
    },
    onError: (err: Error) => {
      if (err.message === "Unauthorized") {
        toast({ title: "Session expired", description: "Please re-enter your password.", variant: "destructive" });
        onLock();
      }
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/card-database/clear", {
        method: "DELETE",
        headers: authHeader,
      });
      if (res.status === 401) throw new Error("Unauthorized");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/card-database/stats"] });
      setCardsResult(null);
      setVariationsResult(null);
      toast({ title: "Database cleared", description: "All card database entries removed." });
    },
    onError: (err: Error) => {
      if (err.message === "Unauthorized") {
        toast({ title: "Session expired", description: "Please re-enter your password.", variant: "destructive" });
        onLock();
      } else {
        toast({ title: "Clear failed", variant: "destructive" });
      }
    },
  });

  const handleCardsImport = async () => {
    const file = cardsFileRef.current?.files?.[0];
    if (!file) { toast({ title: "No file selected", variant: "destructive" }); return; }
    setCardsResult(null);
    try {
      const result = await uploadMutation.mutateAsync({ file, endpoint: "/api/card-database/import-cards" });
      setCardsResult(result);
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: ["/api/card-database/stats"] });
        toast({ title: "Cards imported", description: result.replaced > 0 ? `${result.imported.toLocaleString()} cards loaded (${result.replaced.toLocaleString()} previous rows replaced).` : `${result.imported.toLocaleString()} cards loaded.` });
      } else {
        toast({ title: "Import failed", description: result.error, variant: "destructive" });
      }
    } catch (err: any) {
      if (err?.message !== "Unauthorized") {
        toast({ title: "Import failed", variant: "destructive" });
      }
    }
  };

  const handleVariationsImport = async () => {
    const file = variationsFileRef.current?.files?.[0];
    if (!file) { toast({ title: "No file selected", variant: "destructive" }); return; }
    setVariationsResult(null);
    try {
      const result = await uploadMutation.mutateAsync({ file, endpoint: "/api/card-database/import-variations" });
      setVariationsResult(result);
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: ["/api/card-database/stats"] });
        toast({ title: "Variations imported", description: result.replaced > 0 ? `${result.imported.toLocaleString()} variations loaded (${result.replaced.toLocaleString()} previous rows replaced).` : `${result.imported.toLocaleString()} variations loaded.` });
      } else {
        toast({ title: "Import failed", description: result.error, variant: "destructive" });
      }
    } catch (err: any) {
      if (err?.message !== "Unauthorized") {
        toast({ title: "Import failed", variant: "destructive" });
      }
    }
  };

  const isPending = uploadMutation.isPending;

  return (
    <div className="p-4 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="w-5 h-5 text-blue-600" />
          <h2 className="text-lg font-semibold">Card Database</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={onLock} className="text-slate-500 hover:text-slate-700 gap-1.5">
          <LogOut className="w-3.5 h-3.5" />
          Lock
        </Button>
      </div>

      {/* Stats */}
      <Card>
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center justify-between">
            Database Status
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => refetchStats()}>
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {statsLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex gap-4">
              <div className="text-center">
                <p className="text-2xl font-bold text-blue-600">{stats?.cards?.toLocaleString() ?? 0}</p>
                <p className="text-xs text-muted-foreground">Cards</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-purple-600">{stats?.variations?.toLocaleString() ?? 0}</p>
                <p className="text-xs text-muted-foreground">Variations</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Import Cards */}
      <Card>
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-semibold">Import Cards CSV</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            CSV columns: brand_id, brand, year, collection, card_number_raw, cmp_number, player_name, team, rookie_flag, notes
          </p>
          <input
            ref={cardsFileRef}
            type="file"
            accept=".csv"
            className="block w-full text-sm text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
          />
          <Button onClick={handleCardsImport} disabled={isPending} size="sm" className="w-full">
            {isPending ? (
              <><RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Importing…</>
            ) : (
              <><Upload className="w-3.5 h-3.5 mr-1.5" /> Import Cards</>
            )}
          </Button>
          {cardsResult && <ImportResultBadge result={cardsResult} label="cards" />}
        </CardContent>
      </Card>

      {/* Import Variations */}
      <Card>
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-semibold">Import Variations CSV</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            CSV columns: brand_id, brand, year, collection, variation_or_parallel, serial_number, cmp_number, hobby_odds, jumbo_odds, breaker_odds, value_odds
          </p>
          <input
            ref={variationsFileRef}
            type="file"
            accept=".csv"
            className="block w-full text-sm text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-medium file:bg-purple-50 file:text-purple-700 hover:file:bg-purple-100"
          />
          <Button
            onClick={handleVariationsImport}
            disabled={isPending}
            size="sm"
            variant="outline"
            className="w-full border-purple-300 text-purple-700 hover:bg-purple-50"
          >
            {isPending ? (
              <><RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Importing…</>
            ) : (
              <><Upload className="w-3.5 h-3.5 mr-1.5" /> Import Variations</>
            )}
          </Button>
          {variationsResult && <ImportResultBadge result={variationsResult} label="variations" />}
        </CardContent>
      </Card>

      {/* Clear */}
      <Card className="border-red-100">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-semibold text-red-600">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Wipe the entire card database so you can re-import updated CSVs from scratch.
          </p>
          <Button
            variant="destructive"
            size="sm"
            className="w-full"
            disabled={clearMutation.isPending}
            onClick={() => {
              if (confirm("Clear the entire card database? This cannot be undone.")) {
                clearMutation.mutate();
              }
            }}
          >
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
            Clear All Data
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Root export: gate wrapper ────────────────────────────────────────────────

export default function CardDatabaseAdmin() {
  const [password, setPassword] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(true);

  // On every mount, re-verify any stored session password against the server.
  // This ensures the gate re-appears if the password changed or the session
  // was tampered with, rather than blindly trusting sessionStorage.
  useEffect(() => {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (!stored) {
      setVerifying(false);
      return;
    }
    fetch("/api/card-database/check-auth", {
      headers: { "x-admin-password": stored },
    })
      .then((res) => {
        if (res.ok) {
          setPassword(stored);
        } else {
          sessionStorage.removeItem(SESSION_KEY);
        }
      })
      .catch(() => {
        sessionStorage.removeItem(SESSION_KEY);
      })
      .finally(() => setVerifying(false));
  }, []);

  const handleUnlock = (pw: string) => setPassword(pw);

  const handleLock = () => {
    sessionStorage.removeItem(SESSION_KEY);
    setPassword(null);
  };

  if (verifying) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!password) {
    return <PasswordGate onUnlock={handleUnlock} />;
  }

  return <AdminPanel password={password} onLock={handleLock} />;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function ImportResultBadge({ result, label }: { result: ImportResult; label: string }) {
  const [showAll, setShowAll] = useState(false);
  const hasErrors = result.errors && result.errors.length > 0;
  const displayed = showAll ? result.errors : result.errors?.slice(0, 5);

  const downloadErrors = () => {
    const text = result.errors.join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${label.toLowerCase().replace(/\s+/g, "_")}_skipped_rows.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-2">
      {result.success ? (
        <div className="flex flex-wrap items-center gap-1.5 text-green-700 text-xs">
          <CheckCircle className="w-3.5 h-3.5" />
          <span>{result.imported.toLocaleString()} rows imported</span>
          {result.replaced > 0 && (
            <Badge variant="outline" className="text-blue-700 border-blue-300 text-[10px]">
              {result.replaced.toLocaleString()} replaced
            </Badge>
          )}
          {result.errorCount > 0 && (
            <Badge variant="outline" className="text-yellow-700 border-yellow-300 text-[10px]">
              {result.errorCount} skipped
            </Badge>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-red-600 text-xs">
          <AlertCircle className="w-3.5 h-3.5" />
          <span>{result.error || "Import failed"}</span>
        </div>
      )}
      {hasErrors && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-medium text-yellow-700">
              {result.errors.length} skipped row{result.errors.length !== 1 ? "s" : ""}:
            </p>
            <div className="flex gap-1.5">
              {result.errors.length > 5 && (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="text-[10px] text-blue-600 hover:underline"
                >
                  {showAll ? "Show less" : `Show all ${result.errors.length}`}
                </button>
              )}
              <button
                type="button"
                onClick={downloadErrors}
                className="text-[10px] text-blue-600 hover:underline"
              >
                Download
              </button>
            </div>
          </div>
          <ul className={`text-[10px] text-muted-foreground space-y-0.5 pl-2 ${showAll ? "max-h-48 overflow-y-auto" : ""}`}>
            {displayed?.map((e, i) => (
              <li key={i} className="truncate">{e}</li>
            ))}
            {!showAll && result.errors.length > 5 && (
              <li className="text-muted-foreground italic">…and {result.errors.length - 5} more</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
