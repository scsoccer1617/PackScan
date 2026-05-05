/**
 * POST /api/scan-confirmations — companion to /api/scan-corrections.
 *
 * The client fires this when a dealer hits Save / 👍 with zero edits
 * against the analyzer's snapshot. One row per confirmed scan; the row
 * is the positive label ("model right, human verified") that pairs
 * with the negatives PR Z logs from /api/scan-corrections.
 *
 * Fire-and-forget: the endpoint returns 202 immediately and the Sheets
 * append happens in the background. Append failures never propagate.
 */
import type { Express, Request } from 'express';
import { randomUUID } from 'crypto';
import {
  appendConfirmationRow,
  type ConfirmationPayload,
  type ConfirmationSource,
  type ReviewerRole,
} from '../scanConfirmationsLog';

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'daniel.j.holley@gmail.com').toLowerCase();

export interface ResolvedReviewer {
  reviewerId: string;
  reviewerRole: ReviewerRole;
}

/**
 * Map the request's authenticated user to a (reviewerId, reviewerRole)
 * pair. Mirrors PR Z's spec:
 *   - email matches ADMIN_EMAIL → admin
 *   - authenticated, non-admin email → external (id = email)
 *   - authenticated but no email → external (id = `user:<numericId>`)
 *   - unauthenticated → anonymous
 */
export function resolveReviewer(req: Request): ResolvedReviewer {
  const user = (req as any).user as { id?: number | string; email?: string } | undefined;
  if (!user) return { reviewerId: 'anonymous', reviewerRole: 'anonymous' };
  const email = (user.email ?? '').toLowerCase();
  if (email && email === ADMIN_EMAIL) {
    return { reviewerId: email, reviewerRole: 'admin' };
  }
  if (email) return { reviewerId: email, reviewerRole: 'external' };
  if (user.id != null) return { reviewerId: `user:${user.id}`, reviewerRole: 'external' };
  return { reviewerId: 'anonymous', reviewerRole: 'anonymous' };
}

interface BuildResult {
  ok: true;
  payload: ConfirmationPayload;
}
interface BuildError {
  ok: false;
  error: string;
}

const VALID_SOURCES: ConfirmationSource[] = ['single_scan', 'bulk_review'];

function pickStr(o: Record<string, any>, ...keys: string[]): string | null | undefined {
  for (const k of keys) {
    if (k in o) return o[k];
  }
  return undefined;
}

/**
 * Validate the inbound JSON and assemble a ConfirmationPayload. Accepts
 * both snake_case and camelCase keys for the predicted-* fields so the
 * client can stay in its native casing without extra mapping.
 */
export function buildConfirmationFromRequest(
  body: Record<string, any> | undefined,
  reviewer: ResolvedReviewer,
): BuildResult | BuildError {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const scanId = body.scan_id ?? body.scanId;
  if (!scanId || typeof scanId !== 'string') return { ok: false, error: 'scan_id required' };
  const source = (body.source ?? 'single_scan') as ConfirmationSource;
  if (!VALID_SOURCES.includes(source)) return { ok: false, error: 'invalid source' };

  const predicted = (body.predicted ?? {}) as Record<string, any>;
  const payload: ConfirmationPayload = {
    confirmationId: randomUUID(),
    timestamp: new Date().toISOString(),
    scanId,
    reviewerId: reviewer.reviewerId,
    reviewerRole: reviewer.reviewerRole,
    source,
    predictedPlayer: pickStr(predicted, 'player'),
    predictedYear: pickStr(predicted, 'year'),
    predictedBrand: pickStr(predicted, 'brand'),
    predictedSet: pickStr(predicted, 'set'),
    predictedCollection: pickStr(predicted, 'collection'),
    predictedCardNumber: pickStr(predicted, 'card_number', 'cardNumber'),
    predictedVariant: pickStr(predicted, 'variant'),
    predictedPotentialVariant: pickStr(predicted, 'potential_variant', 'potentialVariant'),
    frontImageUrl: body.front_image_url ?? body.frontImageUrl ?? null,
    backImageUrl: body.back_image_url ?? body.backImageUrl ?? null,
    originalConfidence: body.original_confidence ?? body.originalConfidence ?? null,
  };
  return { ok: true, payload };
}

export function registerScanConfirmationsRoutes(app: Express, apiPrefix = '/api') {
  app.post(`${apiPrefix}/scan-confirmations`, (req, res) => {
    try {
      const reviewer = resolveReviewer(req);
      const built = buildConfirmationFromRequest(req.body || {}, reviewer);
      if (!built.ok) {
        return res.status(400).json({ ok: false, error: built.error });
      }
      // Fire-and-forget — never block the client on a Sheets call.
      void appendConfirmationRow(built.payload).catch((err) => {
        console.warn('[scanConfirmations] append failed:', (err as Error)?.message);
      });
      return res.status(202).json({
        ok: true,
        confirmation_id: built.payload.confirmationId,
      });
    } catch (err: any) {
      console.warn('[scanConfirmations] handler failed:', err?.message);
      return res.status(202).json({ ok: false });
    }
  });
}
