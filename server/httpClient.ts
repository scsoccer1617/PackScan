/**
 * Shared axios client with HTTPS keep-alive.
 *
 * Node's default `https.Agent` does not enable keep-alive, so every outbound
 * call (eBay Browse API, eBay OAuth token refresh, etc.) pays a fresh TLS
 * handshake — typically 50–150 ms per request on warm sockets. Pointing the
 * outbound HTTP paths at this single shared agent reuses the underlying TCP
 * connection across the per-scan flurry of calls.
 *
 * `maxSockets: 32` is generous for a single Replit-class node and prevents
 * connection-pool starvation when bulk-scan fires many comps lookups in
 * parallel.
 */
import axios from 'axios';
import https from 'https';
import http from 'http';

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
});

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 32,
});

export const sharedHttpClient = axios.create({
  httpsAgent,
  httpAgent,
});
