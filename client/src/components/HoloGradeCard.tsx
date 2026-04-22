import { motion } from "framer-motion";
import {
  Award,
  CircleDot,
  Crown,
  Hash,
  Layers,
  RotateCcw,
  Scan,
  ShieldCheck,
  Sparkles,
  Square,
  Target,
  User,
  Wand2,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * Wire-compatible shape returned by the PackScan backend under `data.holo`.
 * Mirrors server/holo/cardGrader.ts#HoloGrade and the hydrated row returned
 * by server/holo/storage.ts#hydrateGrade.
 */
export type HoloSubGrade = { score: number; notes: string };

export type HoloIdentification = {
  player: string;
  brand: string | null;
  setName: string;
  collection: string | null;
  year: string;
  cardNumber: string | null;
  serialNumber: string | null;
  parallel: string | null;
  variant: string | null;
  cmpCode: string | null;
  sport: string;
  confidence: number;
};

export type HoloGrade = {
  id?: number;
  createdAt?: string | Date;
  centering: HoloSubGrade;
  centeringBack: HoloSubGrade | null;
  corners: HoloSubGrade;
  edges: HoloSubGrade;
  surface: HoloSubGrade;
  overall: number;
  label: string;
  notes: string[];
  confidence: number;
  model: string;
  frontOnly: boolean;
  identification?: HoloIdentification | null;
};

type Tone = "gold" | "cyan" | "green" | "amber" | "red";

function gradeTone(score: number): Tone {
  if (score >= 9.5) return "gold";
  if (score >= 9) return "cyan";
  if (score >= 8) return "green";
  if (score >= 6) return "amber";
  return "red";
}

const TONE_STYLES: Record<
  Tone,
  { bar: string; text: string; ring: string; badge: string }
> = {
  gold: {
    bar: "bg-amber-400",
    text: "text-amber-500",
    ring: "ring-amber-400/40",
    badge: "bg-amber-400 text-amber-950",
  },
  cyan: {
    bar: "bg-cyan-400",
    text: "text-cyan-500",
    ring: "ring-cyan-400/40",
    badge: "bg-cyan-400 text-cyan-950",
  },
  green: {
    bar: "bg-emerald-500",
    text: "text-emerald-600",
    ring: "ring-emerald-500/30",
    badge: "bg-emerald-500 text-white",
  },
  amber: {
    bar: "bg-orange-500",
    text: "text-orange-600",
    ring: "ring-orange-500/30",
    badge: "bg-orange-500 text-white",
  },
  red: {
    bar: "bg-red-500",
    text: "text-red-600",
    ring: "ring-red-500/30",
    badge: "bg-red-500 text-white",
  },
};

function formatGrade(g: number) {
  return Number.isInteger(g) ? g.toFixed(0) : g.toFixed(1);
}

function SubGradeRow({
  label,
  score,
  notes,
  icon,
  testId,
}: {
  label: string;
  score: number;
  notes: string;
  icon: React.ReactNode;
  testId: string;
}) {
  const tone = TONE_STYLES[gradeTone(score)];
  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="text-muted-foreground">{icon}</span>
          {label}
        </div>
        <div className={`font-mono text-sm font-semibold ${tone.text}`}>
          {formatGrade(score)}
          <span className="text-muted-foreground">/10</span>
        </div>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
        <motion.div
          className={`absolute inset-y-0 left-0 ${tone.bar}`}
          initial={{ width: 0 }}
          animate={{ width: `${(score / 10) * 100}%` }}
          transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
      {notes && <p className="text-xs leading-relaxed text-muted-foreground">{notes}</p>}
    </div>
  );
}

export interface HoloGradeCardProps {
  grade: HoloGrade | null | undefined;
}

// Identification match tone buckets — mirror the grade tones but keyed on %.
function matchTone(confidence: number): Tone {
  if (confidence >= 0.95) return "gold";
  if (confidence >= 0.85) return "cyan";
  if (confidence >= 0.7) return "green";
  if (confidence >= 0.5) return "amber";
  return "red";
}

function IdField({
  icon,
  label,
  value,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null | undefined;
  testId: string;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2" data-testid={testId}>
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <div className="text-[0.6rem] uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="truncate text-sm font-medium">{value}</div>
      </div>
    </div>
  );
}

function IdentificationPanel({ id }: { id: HoloIdentification }) {
  const tone = TONE_STYLES[matchTone(id.confidence)];
  const matchPct = Math.round(id.confidence * 100);
  const yearPlusSet = [id.year, id.setName].filter(Boolean).join(" ");
  return (
    <div
      className="relative mb-6 rounded-lg border bg-muted/30 p-4"
      data-testid="holo-identification-panel"
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <Wand2 className="h-3.5 w-3.5" />
            Holo identification
          </div>
          <div className="mt-1.5 truncate text-xl font-semibold" data-testid="text-holo-player">
            {id.player}
          </div>
          {yearPlusSet && (
            <div className="text-sm text-muted-foreground" data-testid="text-holo-set">
              {yearPlusSet}
              {id.collection && <span className="ml-1.5">· {id.collection}</span>}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[0.6rem] uppercase tracking-wider text-muted-foreground">
            Match
          </div>
          <div
            className={`font-mono text-2xl font-semibold ${tone.text}`}
            data-testid="text-holo-match"
          >
            {matchPct}%
          </div>
        </div>
      </div>
      {/* Match bar */}
      <div className="mb-4 h-1 overflow-hidden rounded-full bg-muted">
        <motion.div
          className={`h-full ${tone.bar}`}
          initial={{ width: 0 }}
          animate={{ width: `${matchPct}%` }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
      {/* Field grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <IdField
          icon={<Layers className="h-3.5 w-3.5" />}
          label="Brand"
          value={id.brand}
          testId="id-field-brand"
        />
        <IdField
          icon={<Hash className="h-3.5 w-3.5" />}
          label="Card #"
          value={id.cardNumber}
          testId="id-field-card-number"
        />
        <IdField
          icon={<Target className="h-3.5 w-3.5" />}
          label="Sport"
          value={id.sport && id.sport !== "other" ? id.sport.charAt(0).toUpperCase() + id.sport.slice(1) : null}
          testId="id-field-sport"
        />
        <IdField
          icon={<Sparkles className="h-3.5 w-3.5" />}
          label="Parallel"
          value={id.parallel}
          testId="id-field-parallel"
        />
        <IdField
          icon={<Hash className="h-3.5 w-3.5" />}
          label="Serial"
          value={id.serialNumber}
          testId="id-field-serial"
        />
        <IdField
          icon={<User className="h-3.5 w-3.5" />}
          label="Variant"
          value={id.variant}
          testId="id-field-variant"
        />
        <IdField
          icon={<Hash className="h-3.5 w-3.5" />}
          label="CMP code"
          value={id.cmpCode}
          testId="id-field-cmp"
        />
      </div>
      {matchPct < 70 && (
        <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
          Low confidence — please verify the fields above. PackScan's OCR result
          is still being used as the primary source.
        </div>
      )}
    </div>
  );
}

export function HoloGradeCard({ grade }: HoloGradeCardProps) {
  if (!grade) return null;
  const tone = TONE_STYLES[gradeTone(grade.overall)];
  const hasBack = !grade.frontOnly && grade.centeringBack != null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      data-testid="holo-grade-card"
    >
      <Card className={`relative overflow-hidden p-6 ring-1 ${tone.ring}`}>
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.08),transparent_60%)]" />

        {/* Identification panel (shown whenever Claude returned an ID) */}
        {grade.identification && <IdentificationPanel id={grade.identification} />}

        {/* Hero: overall grade + label */}
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              Holo condition grade
              <Badge variant="outline" className="ml-2 font-mono text-[0.65rem]">
                <Sparkles className="mr-1 h-3 w-3" />
                AI
              </Badge>
            </div>
            <div className="mt-2 flex items-baseline gap-3">
              <span
                className={`font-serif text-6xl leading-none tracking-tight sm:text-7xl ${tone.text}`}
                data-testid="text-holo-overall-grade"
              >
                {formatGrade(grade.overall)}
              </span>
              <span className="font-mono text-sm uppercase tracking-widest text-muted-foreground">
                / 10
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge
                className={`${tone.badge} gap-1`}
                data-testid="badge-holo-label"
              >
                {grade.overall >= 9.5 ? (
                  <Crown className="h-3 w-3" />
                ) : (
                  <Award className="h-3 w-3" />
                )}
                {grade.label}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {hasBack ? "Two-sided assessment" : "Front-only estimate"}
              </span>
              <span className="text-xs text-muted-foreground">
                · {Math.round(grade.confidence * 100)}% confidence
              </span>
            </div>
          </div>
        </div>

        {/* Sub-grades */}
        <div className="relative mt-6 grid gap-5 sm:grid-cols-2">
          <SubGradeRow
            label="Centering (front)"
            score={grade.centering.score}
            notes={grade.centering.notes}
            icon={<Scan className="h-3.5 w-3.5" />}
            testId="subgrade-centering-front"
          />
          {grade.centeringBack && (
            <SubGradeRow
              label="Centering (back)"
              score={grade.centeringBack.score}
              notes={grade.centeringBack.notes}
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              testId="subgrade-centering-back"
            />
          )}
          <SubGradeRow
            label="Corners"
            score={grade.corners.score}
            notes={grade.corners.notes}
            icon={<Square className="h-3.5 w-3.5" />}
            testId="subgrade-corners"
          />
          <SubGradeRow
            label="Edges"
            score={grade.edges.score}
            notes={grade.edges.notes}
            icon={<CircleDot className="h-3.5 w-3.5" />}
            testId="subgrade-edges"
          />
          <SubGradeRow
            label="Surface"
            score={grade.surface.score}
            notes={grade.surface.notes}
            icon={<Sparkles className="h-3.5 w-3.5" />}
            testId="subgrade-surface"
          />
        </div>

        {/* Overall notes */}
        {grade.notes && grade.notes.length > 0 && (
          <div className="relative mt-6 border-t pt-4">
            <div className="mb-2 text-[0.65rem] uppercase tracking-wider text-muted-foreground">
              Grader takeaways
            </div>
            <ul className="space-y-1.5 text-xs leading-relaxed text-foreground/90" data-testid="holo-notes">
              {grade.notes.map((n, i) => (
                <li key={i} className="flex gap-2">
                  <span className={`mt-[0.45rem] h-1 w-1 flex-shrink-0 rounded-full ${tone.bar}`} />
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer meta */}
        <div className="relative mt-4 flex flex-wrap items-center justify-between gap-2 text-[0.65rem] uppercase tracking-wider text-muted-foreground">
          <span className="font-mono">Model · {grade.model}</span>
          {grade.id ? <span className="font-mono">Grade #{grade.id}</span> : null}
        </div>
      </Card>
    </motion.div>
  );
}

export default HoloGradeCard;
