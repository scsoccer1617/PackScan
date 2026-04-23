/**
 * useScpParallels — hook for discovering the parallel list of a card
 * from SportsCardsPro.
 *
 * Powers the STEP 3 fallback in ScanResult: when the local parallel DB
 * has no keyword hits for the scanner's detected color, we ask SCP what
 * parallels actually exist for this card instead of showing every
 * parallel in the DB (of which the vast majority will be the wrong
 * color).
 *
 * The server endpoint is cache-backed (24h durable cache), so repeat
 * scans of the same card are free.
 */

import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export interface ScpDiscoveredParallel {
  label: string;
  canonical: string | null;
  productId: string;
  consoleName: string;
}

export interface ScpParallelsResponse {
  parallels: ScpDiscoveredParallel[];
  /** True when the color filter emptied the list and the server fell back
   *  to returning everything. UI should show a soft hint. */
  filterFellBack: boolean;
  query: string;
}

export interface ScpParallelsInput {
  playerName?: string | null;
  year?: number | null;
  brand?: string | null;
  collection?: string | null;
  setName?: string | null;
  cardNumber?: string | null;
  /** Caller's detected color — "Pink", "hot pink", "Gold", etc. Normalized
   *  server-side via colorSynonyms, so any surface form works. */
  colorFilter?: string | null;
  limit?: number;
}

/**
 * Mutation (not a query) because the inputs are structured scan fields
 * that change per invocation and we don't want React Query to cache
 * based on them on the client \u2014 the server has the authoritative cache.
 *
 * Call `mutation.mutateAsync(input)` and await the response; handle
 * empty lists by falling back to the local DB.
 */
export function useScpParallels() {
  return useMutation<ScpParallelsResponse, Error, ScpParallelsInput>({
    mutationFn: async (input) => {
      const resp = await apiRequest<ScpParallelsResponse>({
        url: "/api/catalog/parallels",
        method: "POST",
        body: input,
      });
      return resp;
    },
  });
}
