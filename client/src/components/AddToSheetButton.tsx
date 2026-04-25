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

// Mirrors the server-side `ScanFieldValues` shape (server/userScans.ts).
// We only carry what the scan-result screen has visibility into; anything
// the client doesn't know is left undefined.
export interface ScanFieldSnapshot {
  sport?: string | null;
  playerFirstName?: string | null;
  playerLastName?: string | null;
  brand?: string | null;
  collection?: string | null;
  set?: string | null;
  cardNumber?: string | null;
  year?: number | null;
  variant?: string | null;
  team?: string | null;
  cmpNumber?: string | null;
  serialNumber?: string | null;
  foilType?: string | null;
  isRookie?: boolean | null;
  isAuto?: boolean | null;
  isNumbered?: boolean | null;
  isFoil?: boolean | null;
}

export type ScanUserAction = 'confirmed' | 'declined_edited' | 'saved_no_feedback';

// Sent alongside the card payload as `_scanTracking`. The server logs this
// into `user_scans` after a successful append. None of these fields affect
// the actual sheet write — they're purely for the per-save audit log
// reviewed at /admin/scans.
export interface ScanTracking {
  userAction: ScanUserAction;
  scpScore?: number | null;
  scpMatchedTitle?: string | null;
  cardDbCorroborated?: boolean | null;
  analyzerVersion?: string | null;
  /**
   * Audit-row id returned by /api/analyze-card-dual-images. When present,
   * the save endpoint UPDATEs the analyzed_no_save row instead of inserting
   * a new one, so a single scan produces a single ledger row.
   */
  _userScanId?: number;
}

interface AppendCardPayload {
  sport?: string | null;
  year?: number | string | null;
  brand?: string | null;
  collection?: string | null;
  set?: string | null;
  cardNumber?: string | null;
  cmpNumber?: string | null;
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
  _scanTracking?: ScanTracking & { detected?: ScanFieldSnapshot };
}

interface Props {
  cardData: Partial<CardFormValues> | null;
  averageValue: number;
  searchUrl?: string;
  frontImage?: string;
  backImage?: string;
  /**
   * When true, render a slim pill-sized button that fits inside the
   * ScanResult sticky hero next to "Scan another" instead of the full
   * card with a chevron picker. Shows the destination sheet as a tiny
   * chip directly below the button.
   */
  compact?: boolean;
  /**
   * Optional scan-tracking metadata. When provided, the append payload
   * carries a `_scanTracking` block so the server can log the save to
   * `user_scans` with the right action tag (👍 / 👎 / plain) and a diff
   * against the original detected snapshot. When omitted, the server
   * falls back to logging as 'saved_no_feedback' with no diff.
   */
  scanTracking?: ScanTracking;
  /** Snapshot of fields as the scanner originally returned them. */
  initialDetected?: ScanFieldSnapshot;
}

function buildAppendPayload(
  cardData: Partial<CardFormValues>,
  averageValue: number,
  searchUrl?: string,
  frontImage?: string,
  backImage?: string,
  scanTracking?: ScanTracking,
  initialDetected?: ScanFieldSnapshot,
): AppendCardPayload {
  return {
    sport: cardData.sport ?? null,
    year: cardData.year ?? null,
    brand: cardData.brand ?? null,
    collection: cardData.collection ?? null,
    set: cardData.set ?? null,
    cardNumber: cardData.cardNumber ?? null,
    cmpNumber: (cardData as { cmpNumber?: string | null }).cmpNumber ?? null,
    playerFirstName: cardData.playerFirstName ?? null,
    playerLastName: cardData.playerLastName ?? null,
    variant: cardData.variant ?? null,
    serialNumber: cardData.serialNumber ?? null,
    isRookieCard: cardData.isRookieCard ?? null,
    isAutographed: cardData.isAutographed ?? null,
    isNumbered: cardData.isNumbered ?? null,
    foilType: cardData.foilType ?? null,
    averagePrice: averageValue || null,
    // Forward the captured images as-is — the server will persist any
    // "data:" URIs to /uploads and write the resulting hosted URL into the
    // sheet. Real http(s) URLs pass through unchanged.
    frontImageUrl: frontImage,
    backImageUrl: backImage,
    ebaySearchUrl: searchUrl,
    ...(scanTracking
      ? { _scanTracking: { ...scanTracking, detected: initialDetected } }
      : {}),
  };
}

export default function AddToSheetButton({ cardData, averageValue, searchUrl, frontImage, backImage, compact = false, scanTracking, initialDetected }: Props) {
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
      const card = buildAppendPayload(cardData, averageValue, searchUrl, frontImage, backImage, scanTracking, initialDetected);
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
        const card = buildAppendPayload(cardData, averageValue, searchUrl, frontImage, backImage, scanTracking, initialDetected);
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
    if (compact) {
      // Sticky-hero variant: tiny sign-in hint instead of a full card.
      return (
        <Link
          href="/login"
          className="h-10 px-3 rounded-xl bg-slate-100 text-ink text-sm font-medium flex items-center gap-1.5 hover-elevate"
          data-testid="link-signin-to-save"
        >
          <Sheet className="w-4 h-4" /> Sign in to save
        </Link>
      );
    }
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
    if (compact) {
      return (
        <a
          href="/api/auth/google/connect"
          className="h-10 px-3 rounded-xl bg-slate-100 text-ink text-sm font-medium flex items-center gap-1.5 hover-elevate"
          data-testid="link-connect-google"
        >
          <Sheet className="w-4 h-4" /> Connect Google
        </a>
      );
    }
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

  if (compact) {
    // Compact variant for the ScanResult sticky hero: same size/shape as
    // the adjacent "Scan another" button, with a small destination-sheet
    // chip directly beneath. Omits the picker — users can change the
    // destination sheet from Account Settings or the full variant.
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={() => append.mutate()}
          disabled={append.isPending || !cardData}
          className="h-10 px-4 rounded-xl bg-foil text-white text-sm font-medium flex items-center gap-1.5 hover-elevate disabled:opacity-60 disabled:cursor-not-allowed"
          data-testid="button-add-to-sheet"
        >
          <Sheet className="w-4 h-4" />
          {append.isPending ? 'Saving…' : 'Add to Sheet'}
        </button>
        {selectedSheet && (
          <span
            className="text-[10px] text-slate-500 truncate max-w-[180px] leading-none"
            title={`Saving to ${selectedSheet.title}`}
            data-testid="text-active-sheet"
          >
            → <span className="text-ink font-medium">{selectedSheet.title}</span>
          </span>
        )}
      </div>
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
            {append.isPending ? 'Saving…' : 'Add to GSheet'}
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
