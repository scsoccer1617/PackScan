# vlmSearchVerify

Standalone Gemini + Google-Search-grounding verifier for card
identifications. Lives next to `vlmGemini.ts` but is **not** wired into
the live analyze flow yet — that integration is PR-B.

## What it does

`verifyIdentificationWithSearch(input)` takes a card identification
(player, year, brand, set, cardNumber, optional subset/sport), asks
Gemini-3-flash-preview to search TCDB / Beckett / COMC / eBay sold
listings / Cardboard Connection / Trading Card Database, and returns
the same fields — possibly corrected — plus a `corrections[]` array,
a `confidence` rating, the model's reasoning, and the citation URLs
the search produced.

Common errors it's tuned to catch:

1. **Year off by one.** Upper Deck Minor League and similar products
   ship in calendar year N+1 with a copyright year of N. The primary
   VLM tends to read the back-of-card "© 1994" and emit `year: 1994`
   for what is actually a 1995 product.
2. **Subset-as-set confusion.** The VLM occasionally promotes a
   front-of-card subset ribbon ("Top Prospect", "Future Stock",
   "The Upper Deck Times") into the `set` slot. The verifier catches
   these by cross-referencing TCDB product listings.
3. **Card-number mismatch.** Front-of-card serial numbers and
   back-of-card catalog numbers can disagree; the verifier surfaces
   the catalog number that downstream eBay search expects.

## When to call it

**Only on weak cards.** Grounding adds ~1.5–3s of latency per call; the
median scan must not pay that. PR-B will gate it on at least one of:

- eBay zero-result fallback returned no matching listings.
- Gemini self-reported confidence is below the agreement threshold.
- Year and set-product-line contradict each other.

Until PR-B lands, the only entry point is the manual test script (see
below) — there is no live caller.

## Enabling in production

```sh
# Replit Secret or environment variable
VLM_SEARCH_VERIFY_ENABLED=true
```

Reads through `isVlmSearchVerifyEnabled()` in
`server/featureFlags.ts`. Default off. PR-B will plumb that flag into
the routes-layer caller.

## Cost / latency profile

| Metric          | Typical            | Worst case |
| --------------- | ------------------ | ---------- |
| Wall-clock      | 1.5 – 3 s          | ~6 s       |
| Search calls    | 1 – 3 per request  | up to ~5   |
| Token billing   | Standard text rate | + per-search-call fee |

See [Gemini grounding pricing](https://ai.google.dev/gemini-api/docs/grounding#pricing).

## Failure modes

| Scenario                              | Behavior                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------ |
| Search returns no useful sources      | Returns input unchanged, `confidence: 'low'`, sources empty             |
| Model emits unparseable text          | Returns input unchanged, `confidence: 'low'`, raw text in `rawResponse` |
| Sources disagree                      | Model is instructed to prefer TCDB/Beckett over auction-only data       |
| SDK / network error                   | Throws — caller should fall through to the un-verified identification    |
| `GEMINI_API_KEY` not set              | Throws synchronously on first call                                       |

## Manual test runner

```sh
GEMINI_API_KEY=... npx tsx scripts/testSearchVerify.ts
```

Runs five hardcoded cases (year-off-by-one, subset-as-set, two
expected-clean cases, and a wrong-card-number case) and prints input,
output, latency, and a summary table. Burns 5–15s of wall clock and a
handful of search-grounded calls per run.

## Notes on the SDK shape

Structured output (`responseMimeType: 'application/json'` + `responseSchema`)
does not compose with grounding tools in `@google/genai` v1.x — the
combination is rejected by the API. The verifier therefore asks the
model for fenced JSON in plain text and parses it with `JSON.parse`
after stripping the fences. If a future SDK version composes the two,
this module can switch to structured output without changing its
public types.

## Out of scope for this module

- No retry / backoff loop. The primary `vlmGemini.ts` has 429 retry;
  this verifier intentionally does not — PR-B can layer that on if the
  search-grounded endpoint shares the same quota class.
- No caching. The fields-only input is small (~250 tokens) and the
  search results are time-sensitive; caching would mask correctness
  regressions.
- No image inputs. The primary VLM already saw the card; the verifier
  works strictly off the structured identification.
