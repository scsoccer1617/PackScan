import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";

/**
 * Per-user preferences, fetched from /api/user/preferences.
 *
 * Mirrors `UserPreferences` in shared/schema.ts. Duplicated as a plain
 * client-side type because @shared isn't set up for client imports and a
 * single-field shape doesn't justify a new alias.
 */
export type UserPreferences = {
  autoGrade: boolean;
};

export const DEFAULT_PREFERENCES: UserPreferences = {
  autoGrade: false,
};

type PreferencesResponse = { preferences: UserPreferences };

/**
 * Returns the signed-in user's preferences plus a mutation to update them.
 *
 * Unauthenticated callers get `DEFAULT_PREFERENCES` and a no-op mutation
 * so components can render without an auth gate (e.g. if a future surface
 * wants to show "sign in to change this"). The query is only enabled when
 * the user is authenticated, avoiding a 401 on every page load.
 */
export function usePreferences() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery<PreferencesResponse>({
    queryKey: ["/api/user/preferences"],
    enabled: !!user,
  });

  const mutation = useMutation({
    mutationFn: async (patch: Partial<UserPreferences>) => {
      return apiRequest<PreferencesResponse>({
        url: "/api/user/preferences",
        method: "PATCH",
        body: patch,
      });
    },
    onSuccess: (data) => {
      // Server returns the full normalized preferences object. Write it
      // straight into the cache so the UI reflects the new value without
      // a refetch round-trip.
      queryClient.setQueryData<PreferencesResponse>(
        ["/api/user/preferences"],
        data,
      );
    },
  });

  const preferences = query.data?.preferences ?? DEFAULT_PREFERENCES;

  return {
    preferences,
    isLoading: query.isLoading,
    isError: query.isError,
    update: mutation.mutate,
    updateAsync: mutation.mutateAsync,
    isUpdating: mutation.isPending,
  };
}
