import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExternalLink, Star, Pencil, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface Sheet { id: number; userId: number; googleSheetId: string; title: string; isDefault: boolean; createdAt: string; }
interface SheetsResponse { sheets: Sheet[]; activeSheetId: number | null; }

export default function MySheets() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [newTitle, setNewTitle] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const { data, isLoading } = useQuery<SheetsResponse>({
    queryKey: ['/api/sheets'],
    enabled: !!user,
  });

  const createMutation = useMutation({
    mutationFn: async (title: string) =>
      apiRequest({ url: '/api/sheets', method: 'POST', body: JSON.stringify({ title }) }),
    onSuccess: () => {
      setNewTitle('');
      queryClient.invalidateQueries({ queryKey: ['/api/sheets'] });
      toast({ title: 'Sheet created' });
    },
    onError: (err: any) => {
      const msg = String(err?.message || '').replace(/^\d+:\s*/, '');
      let parsed = msg; try { parsed = JSON.parse(msg).error || msg; } catch {}
      if (parsed.includes('Connect Google')) {
        toast({ title: 'Google not connected', description: 'Connect Google to create sheets.', variant: 'destructive' });
      } else {
        toast({ title: 'Failed to create sheet', description: parsed, variant: 'destructive' });
      }
    },
  });

  const setActive = useMutation({
    mutationFn: async (id: number) => apiRequest({ url: `/api/sheets/${id}/active`, method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/sheets'] }),
  });

  const renameSheet = useMutation({
    mutationFn: async ({ id, title }: { id: number; title: string }) =>
      apiRequest({ url: `/api/sheets/${id}`, method: 'PATCH', body: JSON.stringify({ title }) }),
    onSuccess: () => {
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ['/api/sheets'] });
    },
  });

  const unlinkSheet = useMutation({
    mutationFn: async (id: number) => apiRequest({ url: `/api/sheets/${id}`, method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/sheets'] }),
  });

  if (!user) return <div className="p-4 text-sm text-slate-600">Please sign in to manage your sheets.</div>;

  const sheets = data?.sheets || [];
  const needsGoogle = !user.googleConnected;

  return (
    <div className="p-4 space-y-4 max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold">My Sheets</h1>

      {needsGoogle && (
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-slate-700 mb-2">Connect your Google account to create and sync Sheets.</p>
            <a href="/api/auth/google/connect"><Button size="sm">Connect Google</Button></a>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Create new sheet</CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. Box 12, Client: Smith"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              disabled={needsGoogle}
            />
            <Button
              onClick={() => createMutation.mutate(newTitle)}
              disabled={!newTitle.trim() || createMutation.isPending || needsGoogle}
            >
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Your sheets</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? <p className="text-sm text-slate-500">Loading…</p> : sheets.length === 0 ? (
            <p className="text-sm text-slate-500">You don't have any sheets yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {sheets.map((s) => (
                <li key={s.id} className="py-3 flex items-center gap-2">
                  {editingId === s.id ? (
                    <>
                      <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="flex-1" />
                      <Button size="sm" onClick={() => renameSheet.mutate({ id: s.id, title: editTitle })}>Save</Button>
                      <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>Cancel</Button>
                    </>
                  ) : (
                    <>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{s.title}</span>
                          {s.isDefault && (
                            <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded flex items-center gap-1">
                              <Star className="h-3 w-3" /> Active
                            </span>
                          )}
                        </div>
                      </div>
                      {!s.isDefault && (
                        <Button size="sm" variant="ghost" onClick={() => setActive.mutate(s.id)} title="Set active">
                          <Star className="h-4 w-4" />
                        </Button>
                      )}
                      <a href={`https://docs.google.com/spreadsheets/d/${s.googleSheetId}`} target="_blank" rel="noopener noreferrer">
                        <Button size="sm" variant="ghost" title="Open in Google">
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      </a>
                      <Button size="sm" variant="ghost" onClick={() => { setEditingId(s.id); setEditTitle(s.title); }} title="Rename">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => {
                        if (window.confirm(`Unlink "${s.title}"? The Google Sheet will not be deleted.`)) unlinkSheet.mutate(s.id);
                      }} title="Unlink">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
