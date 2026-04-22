type Props = {
  className?: string;
  /** Render as a filled "app tile" (for the top-bar brand mark). Default false = stroke-only. */
  tile?: boolean;
};

/**
 * PackScan mark — a bold rounded "P" bisected by a foil scan line.
 * The P speaks "PackScan"; the horizontal scan line is the Holo signature.
 * Works mono at 16px, foil-gradient at 1024px.
 */
export default function Logo({ className = "h-7 w-7", tile = false }: Props) {
  if (tile) {
    return (
      <svg
        viewBox="0 0 48 48"
        className={className}
        aria-label="PackScan"
        role="img"
      >
        <defs>
          <linearGradient id="ps-tile-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="hsl(260 80% 58%)" />
            <stop offset="55%" stopColor="hsl(220 85% 54%)" />
            <stop offset="100%" stopColor="hsl(188 80% 52%)" />
          </linearGradient>
        </defs>
        <rect
          x="0"
          y="0"
          width="48"
          height="48"
          rx="11"
          fill="url(#ps-tile-bg)"
        />
        <PGlyph fill="#FFFFFF" scanStroke="rgba(255,255,255,0.55)" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 48 48"
      className={className}
      aria-label="PackScan"
      role="img"
    >
      <defs>
        <linearGradient id="ps-scan" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="hsl(260 80% 58%)" />
          <stop offset="100%" stopColor="hsl(188 80% 52%)" />
        </linearGradient>
      </defs>
      <PGlyph fill="currentColor" scanStroke="url(#ps-scan)" />
    </svg>
  );
}

/**
 * The core glyph — rendered inside either a plain SVG or a filled tile.
 * Drawn as a chunky rounded "P" counter-form cut from a rounded square,
 * with a full-width foil scan line halfway down.
 */
function PGlyph({
  fill,
  scanStroke,
}: {
  fill: string;
  scanStroke: string;
}) {
  return (
    <g>
      {/* The P — outer rounded rect minus inner counter and stem cutout */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill={fill}
        d="
          M14 10
          h14
          a9 9 0 0 1 0 18
          h-6
          v10
          h-8
          V10
          z
          M22 17
          v4
          h6
          a2 2 0 0 0 0 -4
          h-6
          z
        "
      />
      {/* Holo scan line */}
      <line
        x1="8"
        y1="24"
        x2="40"
        y2="24"
        stroke={scanStroke}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </g>
  );
}
