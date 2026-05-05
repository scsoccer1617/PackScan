/**
 * POST /api/scan-corrections — record one or more (predicted →
 * corrected) field events for the ML training dataset.
 *
 * Auth is OPTIONAL: when the caller is signed in we fill reviewer_id
 * from their session (admin email match → "admin", anything else →
 * "external"); anonymous callers are accepted and labelled
 * "anonymous". The endpoint exists to capture as many correction
 * events as possible, so we never reject for lack of auth.
 *
 * Request body:
 *   {
 *     scan_id: string,                      // required
 *     source: "single_scan" | "bulk_review",
 *     front_image_url?: string | null,
 *     back_image_url?: string | null,
 *     original_confidence?: number | null,
 *     notes?: string | null,
 *     corrections: Array<{
 *       field: string,
 *       original_value: any,
 *       corrected_value: any,
 *     }>
 *   }
 *
 * Response: { success: true, count: <rows-written> }
 *
 * Writes one row per non-empty correction to the "Corrections" tab of
 * the Scan Logs workbook (SCAN_LOG_SHEET_ID). The Sheets call is
 * fire-and-forget on the server too — we ack the client immediately
 * so flush latency never blocks save flows. When SCAN_LOG_* env vars
 * are missing the sink is a NOOP and we still return success.
 */

import type { Express, Request } from 'express';
import { randomUUID } from 'node:crypto';
import {
  appendCorrectionRows,
  type CorrectionEvent,
  type CorrectionSource,
  type ReviewerRole,
} from '../scanCorrectionsLogger';

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'daniel.j.holley@gmail.com').toLowerCase();
const VALID_SOURCES: CorrectionSource[] = ['single_scan', 'bulk_review'];

interface IncomingCorrection {
  field?: unknown;
  original_value?: unknown;
  corrected_value?: unknown;
}

interface IncomingBody {
  scan_id?: unknown;
  source?: unknown;
  front_image_url?: unknown;
  back_image_url?: unknown;
  original_confidence?: unknown;
  notes?: unknown;
  corrections?: unknown;
}

export interface ResolvedReviewer {
  reviewerId: string;
  reviewerRole: ReviewerRole;
}

export function resolveReviewer(req: Request): ResolvedReviewer {
  const isAuthed =
    typeof req.isAuthenticated === 'function' ? !!req.isAuthenticated() : false;
  if (!isAuthed) {
    return { reviewerId: 'anonymous', reviewerRole: 'anonymous' };
  }
  const user = req.user as { email?: string; id?: string | number } | undefined;
  const email = (user?.email ?? '').trim().toLowerCase();
  if (email && email === ADMIN_EMAIL) {
    return { reviewerId: email, reviewerRole: 'admin' };
  }
  if (email) {
    return { reviewerId: email, reviewerRole: 'external' };
  }
  if (user?.id != null) {
    return { reviewerId: `user:${user.id}`, reviewerRole: 'external' };
  }
  return { reviewerId: 'anonymous', reviewerRole: 'anonymous' };
}

function coerceString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Validate the body and return the rows we'd write. Pure — used by
 * tests and the route handler. Throws on hard validation failures
 * (missing scan_id, bad source); silently filters individual no-op
 * corrections (empty field name, original === corrected after
 * coercion).
 */
export function buildCorrectionEvents(
  body: IncomingBody,
  reviewer: ResolvedReviewer,
  now: Date = new Date(),
): CorrectionEvent[] {
  const scanId = typeof body.scan_id === 'string' ? body.scan_id.trim() : '';
  if (!scanId) {
    throw new Error('scan_id is required');
  }
  const source = body.source;
  if (typeof source !== 'string' || !VALID_SOURCES.includes(source as CorrectionSource)) {
    throw new Error(
      `source must be one of ${VALID_SOURCES.join(', ')}`,
    );
  }
  const corrections = Array.isArray(body.corrections) ? body.corrections : [];
  const frontUrl =
    typeof body.front_image_url === 'string' ? body.front_image_url : null;
  const backUrl =
    typeof body.back_image_url === 'string' ? body.back_image_url : null;
  const confidence =
    typeof body.original_confidence === 'number' &&
    Number.isFinite(body.original_confidence)
      ? body.original_confidence
      : null;
  const notes = typeof body.notes === 'string' ? body.notes : null;
  const timestamp = now.toISOString();

  const events: CorrectionEvent[] = [];
  for (const raw of corrections as IncomingCorrection[]) {
    if (!raw || typeof raw !== 'object') continue;
    const field = typeof raw.field === 'string' ? raw.field.trim() : '';
    if (!field) continue;
    const originalValue = coerceString(raw.original_value);
    const correctedValue = coerceString(raw.corrected_value);
    if (originalValue === correctedValue) continue;
    events.push({
      correctionId: randomUUID(),
      timestamp,
      scanId,
      reviewerId: reviewer.reviewerId,
      reviewerRole: reviewer.reviewerRole,
      source: source as CorrectionSource,
      field,
      originalValue,
      correctedValue,
      frontImageUrl: frontUrl,
      backImageUrl: backUrl,
      originalConfidence: confidence,
      notes,
    });
  }
  return events;
}

export function registerScanCorrectionsRoutes(app: Express): void {
  app.post('/api/scan-corrections', (req, res) => {
    let events: CorrectionEvent[];
    try {
      const reviewer = resolveReviewer(req);
      events = buildCorrectionEvents(req.body ?? {}, reviewer);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid request';
      return res.status(400).json({ success: false, message });
    }

    // Fire-and-forget the Sheets write so the client doesn't wait on it.
    if (events.length > 0) {
      void appendCorrectionRows(events).catch((err) => {
        console.warn(
          '[scanCorrections] appendCorrectionRows failed:',
          (err as Error).message,
        );
      });
    }

    return res.json({ success: true, count: events.length });
  });
}
