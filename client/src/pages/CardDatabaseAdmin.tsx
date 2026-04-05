import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Database, Upload, Trash2, RefreshCw, CheckCircle, AlertCircle } from "lucide-react";

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

export default function CardDatabaseAdmin() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const cardsFileRef = useRef<HTMLInputElement>(null);
  const variationsFileRef = useRef<HTMLInputElement>(null);

  const [cardsResult, setCardsResult] = useState<ImportResult | null>(null);
  const [variationsResult, setVariationsResult] = useState<ImportResult | null>(null);

  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery<DbStats>({
    queryKey: ["/api/card-database/stats"],
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file, endpoint }: { file: File; endpoint: string }) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(endpoint, { method: "POST", body: formData });
      return res.json() as Promise<ImportResult>;
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      return apiRequest({ url: "/api/card-database/clear", method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/card-database/stats"] });
      setCardsResult(null);
      setVariationsResult(null);
      toast({ title: "Database cleared", description: "All card database entries removed." });
    },
    onError: () => {
      toast({ title: "Clear failed", variant: "destructive" });
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
    } catch {
      toast({ title: "Import failed", variant: "destructive" });
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
    } catch {
      toast({ title: "Import failed", variant: "destructive" });
    }
  };

  const isPending = uploadMutation.isPending;

  return (
    <div className="p-4 space-y-5">
      <div className="flex items-center gap-2">
        <Database className="w-5 h-5 text-blue-600" />
        <h2 className="text-lg font-semibold">Card Database</h2>
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
          <Button
            onClick={handleCardsImport}
            disabled={isPending}
            size="sm"
            className="w-full"
          >
            {isPending ? (
              <><RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Importing…</>
            ) : (
              <><Upload className="w-3.5 h-3.5 mr-1.5" /> Import Cards</>
            )}
          </Button>
          {cardsResult && (
            <ImportResultBadge result={cardsResult} />
          )}
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
          {variationsResult && (
            <ImportResultBadge result={variationsResult} />
          )}
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

function ImportResultBadge({ result }: { result: ImportResult }) {
  return (
    <div className="space-y-1.5">
      {result.success ? (
        <div className="flex items-center gap-1.5 text-green-700 text-xs">
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
      {result.errors && result.errors.length > 0 && (
        <ul className="text-[10px] text-muted-foreground space-y-0.5 pl-2">
          {result.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
          {result.errors.length > 5 && <li>…and {result.errors.length - 5} more</li>}
        </ul>
      )}
    </div>
  );
}
