// Scan tab picker — /scan
//
// Replaces the old behavior where the Scan tab opened the live camera
// directly. The tab now lands on this picker so dealers can deliberately
// choose between Scan (front & back photos), Voice (speak it), and Manual
// (type it) without accidentally kicking off a camera capture they didn't
// want.
//
// The actual capture page lives at /scan/camera. Voice uses the same page
// with ?mode=voice. Manual goes straight to /add-card.

import { Camera, Mic, PenLine } from "lucide-react";
import ModeTile from "@/components/ModeTile";

export default function ScanPicker() {
  return (
    <div className="pt-6 pb-6">
      <div className="px-4">
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink">
          Scan a card
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Pick how you want to add this one.
        </p>
      </div>

      {/* Three equal tiles. Larger than Home's version since this is the
          only content on the page — tap targets should feel confident. */}
      <section className="mx-4 mt-5 grid grid-cols-3 gap-2.5">
        <ModeTile
          href="/scan/camera"
          icon={<Camera className="w-6 h-6" strokeWidth={2.25} />}
          label="Scan"
          hint="Front & back"
          primary
          size="lg"
          testId="picker-tile-scan"
        />
        <ModeTile
          href="/scan/camera?mode=voice"
          icon={<Mic className="w-6 h-6" strokeWidth={2} />}
          label="Voice"
          hint="Speak it"
          tone="voice"
          size="lg"
          testId="picker-tile-voice"
        />
        <ModeTile
          href="/add-card"
          icon={<PenLine className="w-6 h-6" strokeWidth={2} />}
          label="Manual"
          hint="Type it"
          tone="manual"
          size="lg"
          testId="picker-tile-manual"
        />
      </section>

      {/* Lightweight helper copy — dealers moving through hundreds of
          cards shouldn't need this after the first session, but it makes
          the three-way choice legible the first time. */}
      <section className="mx-4 mt-6 space-y-2.5 text-[13px] text-slate-600">
        <p>
          <span className="font-medium text-ink">Scan</span> runs the Holo
          grader and fills pricing from the images.
        </p>
        <p>
          <span className="font-medium text-ink">Voice</span> is fastest for
          bulk — read off player, year, set, and number.
        </p>
        <p>
          <span className="font-medium text-ink">Manual</span> is the
          fallback when you already know every field.
        </p>
      </section>
    </div>
  );
}
