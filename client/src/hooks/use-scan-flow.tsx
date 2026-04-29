// Cross-route state for the Scan → ScanResult flow.
//
// `/scan` owns image capture and calls /api/analyze-card-dual-images. On
// success it stashes the result in this context and navigates to `/result`,
// which reads the same state to drive pickers, grading, and eBay pricing.
//
// We use a React context (instead of localStorage / sessionStorage) because
// the app is also shipped as a sandboxed Capacitor iframe in some builds
// where storage is blocked.

import { createContext, useContext, useState, ReactNode, useCallback } from "react";
import type { CardFormValues } from "@shared/schema";
import type { HoloGrade } from "@/components/HoloGradeCard";
import type { ActiveListing } from "@/components/EbayActiveComps";

// BR-2: top-N active comps the analyze handler kicked off in parallel with
// combineCardResults, plus the exact identity tuple the server hashed eBay
// against. EbayActiveComps consumes `initialComps` on first render to skip
// its mount-time fetch, and compares its live query parts against
// `compsQuery` to know when a refetch is needed (e.g. parallel pick).
export interface InitialCompsPayload {
  query: string;
  active: ActiveListing[];
}
export interface CompsQuerySnapshot {
  year: number | string;
  brand: string;
  set: string;
  cardNumber: string;
  player: string;
  parallel: string;
}

export interface ScanFlowState {
  frontImage: string;
  backImage: string;
  cardData: Partial<CardFormValues> | null;
  holoGrade: HoloGrade | null;
  /**
   * Audit-row id returned by /api/analyze-card-dual-images. Threaded back
   * to the save endpoint as `_scanTracking._userScanId` so the analyze-time
   * `analyzed_no_save` row gets UPDATEd in place instead of duplicated.
   * Null when the analyze response didn't include one (older server / log
   * write failed) — in which case the save falls back to a fresh insert.
   */
  userScanId: number | string | null;
  /** BR-2: top-N active comps from analyze-time eBay parallel fire. Null
   *  on identity-incomplete / timeout / error — client falls back to its
   *  mount-time fetch. */
  initialComps: InitialCompsPayload | null;
  /** BR-2: exact query the server hashed eBay against. Compared against
   *  live cardData query parts to decide whether to refetch. */
  compsQuery: CompsQuerySnapshot | null;
}

const EMPTY: ScanFlowState = {
  frontImage: "",
  backImage: "",
  cardData: null,
  holoGrade: null,
  userScanId: null,
  initialComps: null,
  compsQuery: null,
};

interface ScanFlowContextValue extends ScanFlowState {
  /** Replace every field at once (used by `/scan` after analyze completes). */
  setAll: (next: Partial<ScanFlowState>) => void;
  /** Patch the card data specifically (used by the result page when the
   *  user edits a field and we need to re-run the flow). */
  setCardData: (patch: Partial<CardFormValues> | null) => void;
  /** Reset everything — called when the user taps "Scan another". */
  reset: () => void;
  /** True once an analyze has completed and data is ready for /result. */
  hasResult: boolean;
}

const ScanFlowContext = createContext<ScanFlowContextValue | null>(null);

export function ScanFlowProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ScanFlowState>(EMPTY);

  const setAll = useCallback((next: Partial<ScanFlowState>) => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  const setCardData = useCallback((patch: Partial<CardFormValues> | null) => {
    setState((prev) => ({ ...prev, cardData: patch }));
  }, []);

  const reset = useCallback(() => setState(EMPTY), []);

  const value: ScanFlowContextValue = {
    ...state,
    setAll,
    setCardData,
    reset,
    hasResult: !!state.cardData,
  };

  return (
    <ScanFlowContext.Provider value={value}>
      {children}
    </ScanFlowContext.Provider>
  );
}

export function useScanFlow(): ScanFlowContextValue {
  const ctx = useContext(ScanFlowContext);
  if (!ctx) {
    throw new Error("useScanFlow must be used inside <ScanFlowProvider>");
  }
  return ctx;
}
