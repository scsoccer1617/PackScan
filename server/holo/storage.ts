/**
 * Persistence helpers for Holo grades. Uses the shared Drizzle `db` instance
 * that the rest of PackScan uses, so connection pooling and schema push
 * behave exactly like every other table in the app.
 */

import { desc, eq } from "drizzle-orm";
import { db } from "@db";
import { scanGrades, type ScanGrade } from "@shared/schema";
import type { HoloGrade, HoloIdentification } from "./cardGrader";

export type SaveGradeInput = {
  userId?: number | null;
  cardId?: number | null;
  frontImagePath?: string | null;
  backImagePath?: string | null;
  grade: HoloGrade;
  /** Optional identification captured in the same Claude call. */
  identification?: HoloIdentification | null;
};

export async function saveGrade(input: SaveGradeInput): Promise<ScanGrade> {
  const { grade } = input;
  const [row] = await db
    .insert(scanGrades)
    .values({
      userId: input.userId ?? null,
      cardId: input.cardId ?? null,
      frontImagePath: input.frontImagePath ?? null,
      backImagePath: input.backImagePath ?? null,
      centering: grade.centering.score.toFixed(1),
      centeringBack:
        grade.centeringBack != null ? grade.centeringBack.score.toFixed(1) : null,
      corners: grade.corners.score.toFixed(1),
      edges: grade.edges.score.toFixed(1),
      surface: grade.surface.score.toFixed(1),
      overallGrade: grade.overall.toFixed(1),
      gradeLabel: grade.label,
      notes: {
        centering: grade.centering.notes,
        centeringBack: grade.centeringBack?.notes ?? null,
        corners: grade.corners.notes,
        edges: grade.edges.notes,
        surface: grade.surface.notes,
        overall: grade.notes,
      },
      model: grade.model,
      confidence: grade.confidence.toFixed(3),
      identification: input.identification ?? null,
      identificationConfidence:
        input.identification?.confidence != null
          ? input.identification.confidence.toFixed(3)
          : null,
    })
    .returning();
  return row;
}

/** Most recent grades for a user, newest first. */
export async function listGradesForUser(
  userId: number,
  limit = 25,
): Promise<ScanGrade[]> {
  return db
    .select()
    .from(scanGrades)
    .where(eq(scanGrades.userId, userId))
    .orderBy(desc(scanGrades.createdAt))
    .limit(limit);
}

export async function getGradeById(id: number): Promise<ScanGrade | undefined> {
  const [row] = await db.select().from(scanGrades).where(eq(scanGrades.id, id));
  return row;
}

/**
 * Patch the identification payload on an existing scan_grades row. The scan
 * flow persists the Holo grade immediately (in parallel with the back-OCR
 * identification step) so `saveGrade` is called with `identification: null`.
 * Once the OCR pipeline resolves, the dual-image handler calls this helper
 * to attach the real identification — otherwise the Home screen's Recent
 * Scans carousel renders "Unknown card" forever, even when we know exactly
 * who's on the card.
 */
export async function updateGradeIdentification(
  id: number,
  identification: HoloIdentification | null,
): Promise<void> {
  if (!id) return;
  await db
    .update(scanGrades)
    .set({
      identification: identification ?? null,
      identificationConfidence:
        identification?.confidence != null
          ? identification.confidence.toFixed(3)
          : null,
    })
    .where(eq(scanGrades.id, id));
}

/**
 * Legacy rows stored just the original client filename (e.g. "IMG_1234.jpg")
 * in frontImagePath because the scan route didn't persist the image buffer.
 * Old rows (pre-Object-Storage) stored a local `/uploads/scan_front_<uuid>.jpg`
 * URL that pointed at the ephemeral container disk — those 404 after a redeploy.
 * Current rows store a durable `/objects/uploads/<uuid>` URL backed by Replit
 * Object Storage. Only URL-shaped values are safe to hand the client as an
 * <img src>, so we gate the public field behind a URL-shaped check.
 */
function asImageUrl(v: string | null | undefined): string | null {
  if (!v) return null;
  return (
    v.startsWith("/objects/") ||
    v.startsWith("/uploads/") ||
    v.startsWith("http://") ||
    v.startsWith("https://")
  )
    ? v
    : null;
}

/** Shape a DB row back into the same HoloGrade + identification contract the UI consumes. */
export function hydrateGrade(
  row: ScanGrade,
): HoloGrade & {
  id: number;
  cardId: number | null;
  createdAt: Date;
  identification: HoloIdentification | null;
  frontImage: string | null;
  backImage: string | null;
} {
  const notes = (row.notes ?? {}) as Record<string, any>;
  return {
    id: row.id,
    cardId: row.cardId ?? null,
    createdAt: row.createdAt,
    centering: { score: Number(row.centering), notes: String(notes.centering ?? "") },
    centeringBack:
      row.centeringBack != null
        ? { score: Number(row.centeringBack), notes: String(notes.centeringBack ?? "") }
        : null,
    corners: { score: Number(row.corners), notes: String(notes.corners ?? "") },
    edges: { score: Number(row.edges), notes: String(notes.edges ?? "") },
    surface: { score: Number(row.surface), notes: String(notes.surface ?? "") },
    overall: Number(row.overallGrade),
    label: row.gradeLabel,
    notes: Array.isArray(notes.overall) ? (notes.overall as string[]) : [],
    confidence: row.confidence != null ? Number(row.confidence) : 0,
    model: row.model,
    frontOnly: row.centeringBack == null,
    identification: (row.identification as HoloIdentification | null) ?? null,
    frontImage: asImageUrl(row.frontImagePath),
    backImage: asImageUrl(row.backImagePath),
  };
}
