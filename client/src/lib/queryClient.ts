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
  
  // Return the parsed JSON data if it exists, otherwise return an empty object
  try {
    return await res.json();
  } catch (e) {
    return {} as T;
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
