import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, ExternalLink, Plus } from "lucide-react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { CardFormValues } from "@shared/schema";

interface UserSheet { id: number; googleSheetId: string; title: string; isDefault: boolean; }
interface SheetsResponse { sheets: UserSheet[]; activeSheetId: number | null; }

interface AppendCardPayload {
  year?: number | string | null;
  brand?: string | null;
  collection?: string | null;
  set?: string | null;
  cardNumber?: string | null;
  playerFirstName?: string | null;
  playerLastName?: string | null;
  variant?: string | null;
  serialNumber?: string | null;
  isRookieCard?: boolean | null;
  isAutographed?: boolean | null;
  isNumbered?: boolean | null;
  foilType?: string | null;
  averagePrice: number | null;
  frontImageUrl?: string;
  backImageUrl?: string;
  ebaySearchUrl?: string;
}

interface Props {
  cardData: Partial<CardFormValues> | null;
  averageValue: number;
  searchUrl?: string;
  frontImage?: string;
  backImage?: string;
}

function buildAppendPayload(cardData: Partial<CardFormValues>, averageValue: number, searchUrl?: string, frontImage?: string, backImage?: string): AppendCardPayload {
  return {
    year: cardData.year ?? null,
    brand: cardData.brand ?? null,
    collection: cardData.collection ?? null,
    set: cardData.set ?? null,
    cardNumber: cardData.cardNumber ?? null,
    playerFirstName: cardData.playerFirstName ?? null,
    playerLastName: cardData.playerLastName ?? null,
    variant: cardData.variant ?? null,
    serialNumber: cardData.serialNumber ?? null,
    isRookieCard: cardData.isRookieCard ?? null,
    isAutographed: cardData.isAutographed ?? null,
    isNumbered: cardData.isNumbered ?? null,
    foilType: cardData.foilType ?? null,
    averagePrice: averageValue || null,
    frontImageUrl: frontImage,
    backImageUrl: backImage,
    ebaySearchUrl: searchUrl,
  };
}

export default function AddToSheetButton({ cardData, averageValue, searchUrl, frontImage, backImage }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newSheetTitle, setNewSheetTitle] = useState('');
  const [overrideSheetId, setOverrideSheetId] = useState<number | null>(null);

  const { data: sheetsData } = useQuery<SheetsResponse>({
    queryKey: ['/api/sheets'],
    enabled: !!user && !!user.googleConnected,
  });

  const sheets = sheetsData?.sheets || [];
  const selectedSheet = overrideSheetId
    ? sheets.find(s => s.id === overrideSheetId)
    : sheets.find(s => s.isDefault) || sheets[0];

  const startConnectAndAdd = async (card: AppendCardPayload) => {
    if (!window.confirm('Connect your Google account to save cards to a sheet? You\'ll be brought back here and the card will be added automatically.')) return;
    try {
      await apiRequest({
        url: '/api/auth/google/pending-append',
        method: 'POST',
        body: JSON.stringify({ card, sheetId: selectedSheet?.id }),
      });
    } catch (e) {
      // Stash failed — proceed anyway; the user can retry after connecting.
    }
    window.location.href = '/api/auth/google/connect';
  };

  const append = useMutation({
    mutationFn: async () => {
      if (!cardData) throw new Error('No card data');
      const card = buildAppendPayload(cardData, averageValue, searchUrl, frontImage, backImage);
      const body = { sheetId: selectedSheet?.id, card };
      return apiRequest<{ ok: boolean; sheet: UserSheet; sheetUrl: string }>(
        { url: '/api/sheets/append', method: 'POST', body: JSON.stringify(body) }
      );
    },
    onSuccess: (res) => {
      toast({
        title: 'Saved to Google Sheet',
        description: `Added to ${res.sheet.title}. Open it: ${res.sheetUrl}`,
      });
    },
    onError: (err: unknown) => {
      const msg = String((err as { message?: string })?.message || '').replace(/^\d+:\s*/, '');
      let parsed = msg;
      try { parsed = JSON.parse(msg).error || msg; } catch {}
      const isNotConnected = parsed.includes('Connect Google') || msg.includes('GOOGLE_NOT_CONNECTED');
      if (isNotConnected && cardData) {
        const card = buildAppendPayload(cardData, averageValue, searchUrl, frontImage, backImage);
        startConnectAndAdd(card);
        return;
      }
      toast({ title: 'Could not save card', description: parsed, variant: 'destructive' });
    },
  });

  const createSheet = useMutation({
    mutationFn: async (title: string) => apiRequest<{ sheet: UserSheet }>(
      { url: '/api/sheets', method: 'POST', body: JSON.stringify({ title }) }
    ),
    onSuccess: (res) => {
      setOverrideSheetId(res.sheet.id);
      setNewSheetTitle('');
      setCreatingNew(false);
      queryClient.invalidateQueries({ queryKey: ['/api/sheets'] });
      toast({ title: `Created sheet "${res.sheet.title}"` });
    },
    onError: (err: any) => {
      const msg = String(err?.message || '').replace(/^\d+:\s*/, '');
      let parsed = msg; try { parsed = JSON.parse(msg).error || msg; } catch {}
      toast({ title: 'Could not create sheet', description: parsed, variant: 'destructive' });
    },
  });

  if (!user) {
    return (
      <Card>
        <CardContent className="pt-4 flex items-center gap-3 text-sm text-slate-700">
          <Sheet className="h-4 w-4 text-slate-500" />
          <span><Link href="/login" className="text-blue-600 hover:underline">Sign in</Link> to save this card to a Google Sheet.</span>
        </CardContent>
      </Card>
    );
  }

  if (!user.googleConnected) {
    return (
      <Card>
        <CardContent className="pt-4 space-y-2">
          <div className="flex items-center gap-2 text-sm text-slate-700">
            <Sheet className="h-4 w-4 text-slate-500" />
            Connect Google to save this card to a sheet.
          </div>
          <a href="/api/auth/google/connect">
            <Button size="sm">Connect Google</Button>
          </a>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <Button
            onClick={() => append.mutate()}
            disabled={append.isPending || !cardData}
            className="flex items-center gap-2"
          >
            <Sheet className="h-4 w-4" />
            {append.isPending ? 'Saving…' : 'Add to Google Sheet'}
          </Button>
          <div className="text-xs text-slate-600 flex items-center gap-1">
            Saving to: <span className="font-medium">{selectedSheet?.title || '—'}</span>
            <button type="button" onClick={() => setPickerOpen((o) => !o)} className="text-blue-600 hover:underline">Change</button>
          </div>
        </div>
        {pickerOpen && (
          <div className="border-t border-slate-100 pt-3 space-y-2">
            <div className="text-xs font-medium text-slate-600">Choose a sheet</div>
            <ul className="space-y-1">
              {sheets.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => { setOverrideSheetId(s.id); setPickerOpen(false); }}
                    className={`w-full text-left px-2 py-1.5 rounded text-sm hover:bg-slate-50 ${selectedSheet?.id === s.id ? 'bg-blue-50 text-blue-700' : ''}`}
                  >
                    {s.title} {s.isDefault && <span className="text-xs text-slate-400">(default)</span>}
                  </button>
                </li>
              ))}
            </ul>
            {creatingNew ? (
              <div className="flex gap-2">
                <Input
                  placeholder="New sheet name"
                  value={newSheetTitle}
                  onChange={(e) => setNewSheetTitle(e.target.value)}
                  className="text-sm"
                />
                <Button size="sm" disabled={!newSheetTitle.trim() || createSheet.isPending} onClick={() => createSheet.mutate(newSheetTitle)}>
                  {createSheet.isPending ? '…' : 'Create'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCreatingNew(false)}>Cancel</Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setCreatingNew(true)} className="flex items-center gap-1">
                <Plus className="h-3 w-3" /> Create new sheet…
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
