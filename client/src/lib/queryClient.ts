import { QueryClient, QueryFunction } from "@tanstack/react-query";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

interface ApiRequestOptions {
  url: string;
  method: string;
  body?: any;
  headers?: Record<string, string>;
}

export async function apiRequest<T = any>(
  options: ApiRequestOptions | string,
  optionalConfig?: any
): Promise<T> {
  let url: string;
  let config: RequestInit = {};
  
  // Support both new object-style and legacy string-style calls
  if (typeof options === 'string') {
    // Legacy style: apiRequest(url, { method, body })
    url = options;
    config = optionalConfig || {};
  } else {
    // New style: apiRequest({ url, method, body })
    url = options.url;
    const { headers, body, method } = options;
    
    config = {
      method,
      headers,
      body
    };
  }
  
  // Ensure credentials are included
  config.credentials = 'include';
  
  // If body is not FormData and content-type isn't set, set it to JSON
  if (
    config.body && 
    !(config.body instanceof FormData) && 
    !config.headers?.['Content-Type'] &&
    !(config.headers && Object.keys(config.headers).some(h => h.toLowerCase() === 'content-type'))
  ) {
    config.headers = {
      ...config.headers,
      'Content-Type': 'application/json'
    };
    
    // Convert body to JSON string if it's not already a string
    if (typeof config.body !== 'string') {
      config.body = JSON.stringify(config.body);
    }
  }

  const res = await fetch(url, config);
  await throwIfResNotOk(res);

  // Truly empty bodies (204 No Content, or zero-byte 200s) are valid —
  // return {}. But if the server sent a body, it must be JSON. Silently
  // swallowing a JSON-parse failure used to mask a serious class of
  // bugs: when the server route isn't registered (e.g. stale prod
  // build), Express falls through to the SPA and returns 200 OK with
  // index.html. The old code treated that HTML as a successful empty
  // response, so mutations like DELETE /batches/:id would fire their
  // onSuccess and toast "deleted" while nothing was actually deleted.
  if (res.status === 204) return {} as T;
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Surface the first chunk of the body so the dealer/dev can tell
    // whether they're looking at the SPA fallback ("<!DOCTYPE...") or
    // some other unexpected response shape.
    const preview = text.slice(0, 80).replace(/\s+/g, ' ');
    throw new Error(
      `Server returned non-JSON response (likely a stale deploy or unregistered route): ${preview}…`,
    );
  }
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey[0] as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
