# AI Studio Test Plan — Gemini 2023-Default Bug

**Goal:** Reproduce the bug interactively in Google AI Studio, iterate on the prompt until Gemini returns the correct year on dense baseball stat-table backs, then port the winning prompt into PR #160 (`fix/vlm-year-default-2023-bug`).

**Production call we're trying to mirror exactly:**
- Model: `gemini-2.5-flash`
- Temperature: default (not set in code)
- Response MIME type: `application/json`
- Inputs: `[text prompt, frontImage(jpg), backImage(jpg)]` in that order
- Prompt version on main right now: `2026-04-28.4`

---

## Setup — open AI Studio

1. Go to https://aistudio.google.com/
2. Click **Create new prompt** → **Chat prompt** (not Freeform — Chat lets you pin a system instruction).
3. Top-right model picker → select **`gemini-2.5-flash`** (must match prod). Leave thinking budget at default.
4. Settings panel (right side):
   - **Temperature:** leave at 1.0 (matches our prod default — we don't override)
   - **Output length:** default
   - **Response MIME type:** set to **`application/json`** (matches our `responseMimeType` in `vlmGemini.ts`)
   - **Safety settings:** default
5. **System instructions** (gear icon at top): paste the block in **Section A** below verbatim.

## Inputs — get the failing card images

The 3 failing cards are physical cards you just scanned. Easiest options:

- **Option A — re-photograph each card on your phone** (front + back, well-lit, no glare). This best mirrors a fresh user scan.
- **Option B — pull the exact images from Replit:** SSH/Files panel → `uploads/` directory → look for files modified ~7:30–7:42am EDT on 2026-04-28. Naming pattern is `front_<uuid>.jpg` / `back_<uuid>.jpg`. There is no scan-id → filename map in the repo today (a future PR could add one), so date+time is the easiest filter.

You need 6 JPGs total:
- Trea Turner #450 (front, back) — back has 10 stat rows; ©2025 in legal strip
- Nolan Arenado #193 (front, back) — back has 13 stat rows; ©2026 in legal strip (OCR'd as "D &" on this scan, so the © glyph may be misread)
- Zac Veen US286 (front, back) — back has small dense stats; ©2025 in legal strip

---

## Section A — System prompt (paste verbatim into AI Studio "System instructions")

```
You are the vision model behind Holo, the scanning engine inside PackScan.
On every image pair (front + back), identify whether the subject is a single trading card or sealed product (pack, blaster, hanger, box), then extract structured metadata.

DOMAIN HIERARCHY (every card has all four tiers — do not collapse them):
  1. brand      = the manufacturer (Topps, Panini, Bowman, Upper Deck, Fleer, Donruss, Score, Leaf)
  2. set        = the product/release (NBA Hoops, Topps Series One, Topps Update, Donruss, Score, Bowman Chrome, Panini Prizm, Heritage, Stadium Club, etc.)
  3. collection = the subset/insert WITHIN the set (Premium Stock, Mystical, Holiday, All-Star Game, 1989 Topps 35th Anniversary, Stars of MLB, etc.).
                  When the card is a base card with no special insert, set the collection to the same value as the set (e.g. set="Topps Series One", collection="Topps Series One").
  4. parallel   = the variant/finish of an individual card (Silver, Gold, Refractor, Orange Laser, Rainbow Foil, Hyper, Disco, Shattered, etc.).
                  When the card is the base/default variant of its collection — no colored foil, no numbered print run, no special border treatment — set parallel.name to "None detected".
                  Many collections have a default finish (Premium Stock cards have a Chrome finish by default; Topps Chrome, Bowman Chrome, Prizm all have signature finishes). The default finish is NOT a parallel — only call it a parallel if it differs from the collection's baseline.

CARD-DOMAIN RULES:
- YEAR IS A HARD RULE. Determine the card year by walking this decision tree IN ORDER and stopping at the first rule that fires. The year is the production/release year of the card itself, not a year mentioned in its content.
  1) BACK-SIDE PUBLISHER COPYRIGHT IMPRINT (highest authority on modern cards). Find the publisher copyright line in the back-side legal strip near the bottom edge — usually one line above or below the CMP code. Examples:
       "©2025 THE TOPPS COMPANY, INC." → year=2025
       "©2024 PANINI AMERICA, INC." → year=2024
       "©2023 THE UPPER DECK COMPANY" → year=2023
     If MULTIPLE © lines coexist (e.g. Topps + MLBPA + Players Inc.), pick the LATEST year — that is the publisher imprint; the others are licensing notices.
     EXCEPTION (Leaf / Donruss, 1981–1993 baseball): the publisher imprint on these era cards is often off by one year because production began in late autumn of the prior year. A 1991 Donruss base card commonly prints "©1990 LEAF, INC." — the actual card year is 1991. When the brand is Donruss or Leaf and the imprinted year falls in 1980–1992, treat the imprint year as low confidence and prefer a year detected from the FRONT (set logo / design year) when available.
  2) NBA / NHL SEASON-SPAN PUBLISHER IMPRINT. Card backs in basketball or hockey often print a season span next to the publisher, like "2024-25 PANINI - NBA HOOPS" or "2023-24 UPPER DECK". When the span is consecutive (the trailing two digits equal the first year + 1), return the season-START year (2024 for "2024-25"). This rule fires when no © imprint year is readable but a season-span imprint is.
  3) VINTAGE STAT-ROW + 1 CONVENTION (pre-1995 baseball, before same-season stats became the norm). When the back contains a sequence of ≥3 CONSECUTIVE ASCENDING year values that look like stat-row seasons (e.g. "1976 NEW YORK NL" / "1977 NEW YORK NL" / "1978 NEW YORK NL"), and the latest stat year is ≤1990, the card's year is max(stat year) + 1. Example: stat rows ending at 1979 → year=1980. Do NOT apply this rule on modern cards (1995+) — modern stats are same-season, so the latest stat year IS the card year minus zero.
  4) FRONT-SIDE SEASON SPAN (basketball / hockey only). When the back-side copyright is unreadable but the FRONT prints a span like "2024-25", use the season-start year.
  5) YEAR + TEAM PATTERN. "1979 REDS", "1986 METS" appearing in card-back prose (not a stat row) — use that year.
  6) BARE-YEAR FALLBACK (last resort). Pick the LATEST 4-digit year (1900–2026) that appears anywhere on the card and is NOT inside an obvious bio-context phrase ("BORN", "DRAFTED", "ACQ", "SIGNED", "TRADED", "AGENT"). Prefer the most recent year because vintage stat tables span many seasons and the latest is the production year.
- DO NOT confuse these with the card year:
    * Player stat-row years on modern cards ("23 PHILLIES", "24 ROCKIES") — those are past seasons, not the print year.
    * Draft year, debut year, birth year, "Acquired" date.
    * Front-side season callouts on insert / anniversary cards (e.g. "1989 Topps 35th Anniversary") — those describe the THEME, not the year.
  When in doubt, anchor on rule (1). Never guess from set-design familiarity.
- For NBA/NHL season spans like "2024-25", return the season-START year (2024) in the year field. Preserve the printed string in yearPrintedRaw.
- Never confuse the trailing "-YY" of a season span for a card number.
- Player names: Title Case ("LeBron James", "Ronald Acuña Jr."), not all-caps from how the card prints them.
- Confidence scores: numeric floats 0.0–1.0, not strings like "High" / "Medium". Lower the score when uncertain.
- Judge parallel by visible border tint, foil pattern, and saturation — not just printed text.
- printRun: when a card shows "X/YYY" (e.g. "291/299" or "0101/0399"), return the denominator as a number (299, 399). Set to null if not numbered.
- cmpCode: most card backs print a small manufacturer reference code in the legal/copyright strip near the bottom edge — typically formatted as "CMP" + 4–6 digits (e.g. "CMP100358", "CMP120523"). Read it verbatim into the cmpCode field, including the "CMP" prefix and any leading zeros. If the code is not visible or you cannot read it confidently, return null. This is the single most reliable structural anchor on a modern Topps/Panini card — do not skip it when it is legible.
- If a field is genuinely unreadable, return null. Never guess.
- Return ONLY valid JSON matching the provided template. No prose, no markdown fences.
```

## Section B — User message (paste into the first turn, then attach front+back JPGs)

```
Return JSON matching this template (replace nulls with extracted values, keep all keys):
{
  "subjectType": "card",
  "sport": null,
  "player": null,
  "year": null,
  "yearPrintedRaw": null,
  "brand": null,
  "set": null,
  "collection": null,
  "cardNumber": null,
  "cmpCode": null,
  "parallel": {
    "name": null,
    "isFoil": false,
    "isRefractor": false,
    "borderTint": null,
    "saturation": null
  },
  "isAutograph": false,
  "isRelic": false,
  "isRookie": false,
  "printRun": null,
  "team": null,
  "position": null,
  "confidence": {
    "player": null,
    "year": null,
    "set": null,
    "collection": null,
    "cardNumber": null,
    "cmpCode": null,
    "parallel": null
  },
  "notes": null
}
```

Then paste **front image first**, then **back image second** (matches the order in `vlmGemini.ts` line 149-150). Run.

---

## Test protocol

### Step 1 — Reproduce the bug (baseline)

For each of the 3 failing cards:
1. New chat. Paste system + user prompts above. Attach front, then back.
2. Run. Record the `year` returned.

**Expected if the model has a 2023 prior:** Trea, Nolan, Zac all return `"year": 2023`. This confirms the bug is in the model, not in our pipeline.

If any card returns the correct year, that means our prod call differs in some way — re-check model name, MIME type, image quality, image order.

### Step 2 — Probe what Gemini "sees" in the legal strip

In a follow-up turn, ask:
> "Read the back-side legal strip near the bottom edge verbatim, character by character. Quote any line containing '©' or 'COPYRIGHT' or 'TOPPS' or 'PANINI'."

This tells you whether the model can see the © imprint at all. Three possible outcomes:
- **(a) Model quotes "©2025 THE TOPPS COMPANY, INC." but still returned year=2023** → it sees the imprint but ignored Rule 1. Pure prompt/instruction-following failure. Fix: prompt hardening.
- **(b) Model says it can't read the strip / hallucinates "©2023"** → it literally can't see the small text. Fix: image preprocessing (upscale back image, crop to legal strip) or OCR © guard.
- **(c) Model reads the © correctly only when asked directly** → it's lazy on the JSON path. Fix: prompt restructure to force the © read first.

### Step 3 — Iterate on the prompt until year is correct

Try these in order, stopping at the first one that fixes all 3 cards:

**Iteration 1: Hard "no default" line + chain-of-thought forcing.** Replace Rule 1 with:
```
1) BACK-SIDE PUBLISHER COPYRIGHT IMPRINT (highest authority on modern cards).
   STEP A: Before deciding the year, find and QUOTE the publisher copyright line from the back-side legal strip (the small print near the bottom edge, usually one line above or below the CMP code) into yearPrintedRaw.
   STEP B: Extract the 4-digit year from that quoted line.
   STEP C: That year IS the card year. Do not override it with stat-row years, design-era guesses, or training-data priors.
   You MUST NOT default to 2023 or any other year when you are uncertain. If you cannot read the © imprint, return null for year and explain in notes.
   Examples:
     "©2025 THE TOPPS COMPANY, INC." → year=2025
     "©2024 PANINI AMERICA, INC." → year=2024
     "©2023 THE UPPER DECK COMPANY" → year=2023
   If MULTIPLE © lines coexist (Topps + MLBPA + Players Inc.), pick the LATEST year — that is the publisher imprint; the others are licensing notices.
```

**Iteration 2: Few-shot examples.** Add a `FEW-SHOT EXAMPLES` block before `Return JSON...`:
```
FEW-SHOT EXAMPLES — dense baseball backs:
- Card back has 10 stat rows ending in "24 PHILLIES", legal strip reads "©2025 THE TOPPS COMPANY, INC." → year MUST be 2025 (NOT 2024, NOT 2023). The stat rows describe past seasons; the © year is the print year.
- Card back has 13 stat rows ending in "25 ROCKIES", legal strip reads "©2026 THE TOPPS COMPANY, INC." → year MUST be 2026.
- Card back has 2 small dense stat blocks, legal strip reads "©2025 THE TOPPS COMPANY, INC." → year MUST be 2025. Card-design familiarity ("this looks like 2023 Topps") is NOT evidence; only the © imprint is.
```

**Iteration 3: Restructure JSON template** so `yearPrintedRaw` and `cmpCode` come BEFORE `year`. This forces the model to read the legal strip first when filling in fields top-to-bottom. (Gemini does fill JSON in order with structured output.)

```json
{
  "subjectType": "card",
  "yearPrintedRaw": null,
  "cmpCode": null,
  "year": null,
  ... rest ...
}
```

**Iteration 4: Image preprocessing.** If Step 2 outcome was (b), the model literally can't see the small text at the resolution we send. Before AI Studio test, upscale the back image 2× (any image editor) and re-attach. If that fixes it, the real fix is in `vlmGemini.ts` — either ship full-res back images, or send a cropped legal-strip patch as a 3rd image.

### Step 4 — Acceptance criteria

The winning prompt must satisfy ALL of:
- Trea Turner #450 → year=2025, yearPrintedRaw contains "2025"
- Nolan Arenado #193 → year=2026, yearPrintedRaw contains "2026"
- Zac Veen US286 → year=2025
- Cam Smith H121 → year=2025 (regression check)
- Dalton Knecht (Haunted Hoops) → year=2024 (NBA season-span regression check — Rule 2 must still fire)

Bonus regression: try a vintage 1980 Topps card if you have one handy → Rule 3 (stat-row +1) must still fire.

---

## Section C — Porting the winner into PR #160

Once a prompt iteration passes Step 4:

```bash
cd /home/user/workspace/PackScan
git checkout main && git pull origin main
git checkout -b fix/vlm-year-default-2023-bug
# Edit server/vlmPrompts.ts — apply the exact wording that worked
# Bump VLM_PROMPT_VERSION = '2026-04-28.5'
npx tsc --noEmit 2>&1 | grep -c "error TS"   # must stay 80
npm run build 2>&1 | tail -3                  # clean ~6s
git add -A
git commit -m "fix(vlm): prevent Gemini 2023-default on dense baseball backs

- <which iterations from AI Studio test won>
- bump VLM_PROMPT_VERSION to 2026-04-28.5
- regression: Trea/Nolan/Zac now return correct ©-imprint year
- regression: Cam/Knecht still correct (NBA season-span path intact)"
git push -u origin fix/vlm-year-default-2023-bug
gh pr create --base main --head fix/vlm-year-default-2023-bug \
  --title "fix(vlm): prevent Gemini 2023-default on dense baseball backs" \
  --body-file /tmp/pr_body_160.md
```

Belt-and-suspenders OCR © guard (Option 3 from earlier question) can ride in the same PR or be a follow-up — depends on how confident the prompt fix looks in AI Studio.
