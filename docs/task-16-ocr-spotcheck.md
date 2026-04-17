# Task #16 — OCR Spot-Check Report

Ran the position-aware card-number detector (Task #15) over **32** card-back images.

**Pass criterion** (Task #16): the accepted card # was logged via `[CardNum-pos] Accepting … (TOP)`.
A degenerate pass is recorded when no positional data was available (`UNKNOWN`, no positional data); everything
else (`RELAXED`, `MIDDLE`, `BOTTOM`, `NONE`, error) is treated as a misread.

## Result: ❌ 18 of 32 samples flagged as misreads

### Region distribution
- **NONE**: 4
- **RELAXED**: 14
- **TOP**: 14

## Brand / year / set coverage

Combos derived from the labeled filename when present, otherwise from the OCR result.
Where the same combo appears with both a base and an insert sample, that is called out.

| Combo (brand / year / set) | base | insert | unknown | files |
|---|---:|---:|---:|---|
| Topps / 2024 /  | 0 | 0 | 13 | 13 |
| Topps / 2024 / Topps 35 Year | 0 | 2 | 0 | 2 |
| Topps / 2024 / Stars of MLB | 0 | 2 | 0 | 2 |
| Topps / 1987 / Topps | 2 | 0 | 0 | 2 |
| Topps Chrome / 2024 /  | 0 | 0 | 2 | 2 |
| Topps / 2021 / Heritage | 1 | 0 | 0 | 1 |
| Topps / 2023 / Stars of MLB | 0 | 1 | 0 | 1 |
| Topps / 2024 / Chrome Stars of MLB | 0 | 1 | 0 | 1 |
| Topps / 2024 / Series 2 | 1 | 0 | 0 | 1 |
| Topps / 2024 / Chrome | 1 | 0 | 0 | 1 |
| Score / 1990 / Finest | 0 | 0 | 1 | 1 |
| Topps / 2022 / Opening Day | 0 | 0 | 1 | 1 |
| Topps / 2021 / Series One | 0 | 0 | 1 | 1 |
| Topps / 1987 /  | 0 | 0 | 1 | 1 |
| Score / 1990 /  | 0 | 0 | 1 | 1 |
| Upper Deck / 1989 /  | 0 | 0 | 1 | 1 |

**Distinct brand/year/set combos covered: 16.**

### Coverage caveat

The task asked for "one base + one insert from each of the top ~20 brand/year combos".
This sweep ran against every back-side image already on disk in `attached_assets/` and `uploads/`. We do
not have access to physical scans of every popular set, so coverage is bounded by what the user has
uploaded to date. The combo table above shows what we actually exercised.

## Per-card results

| # | File | Expected | Detected | Region | normY | Source | OK? |
|---|------|---------|----------|--------|-------|--------|-----|
| 1 | `attached_assets/bregman_back_2024_topps_35year.jpg` | Topps / 2024 / Topps 35 Year (insert) | Topps / 2024 / #89B2-32 | TOP | 0.08 | year-prefixed | ✅ TOP |
| 2 | `attached_assets/cole_back_2021_topps_heritage.jpg` | Topps / 2021 / Heritage (base) | Topps / 2021 / Heritage / #249 | TOP | 0.06 | first-line-digit | ✅ TOP |
| 3 | `attached_assets/correa_back_2024_topps_smlb.jpg` | Topps / 2024 / Stars of MLB (insert) | Topps / 2024 / #SMLB-49 | TOP | 0.18 | dash-number | ✅ TOP |
| 4 | `attached_assets/freedman_back_2023_topps_smlb.jpg` | Topps / 2023 / Stars of MLB (insert) | Topps / 2023 / #SMLB-27 | TOP | 0.07 | dash-number | ✅ TOP |
| 5 | `attached_assets/frelick_back_2024_35year.jpg` | Topps / 2024 / Topps 35 Year (insert) | Topps / 2024 / #89B-9 | TOP | 0.11 | year-prefixed | ✅ TOP |
| 6 | `attached_assets/machado_back_2024_topps_csmlb.jpg` | Topps / 2024 / Chrome Stars of MLB (insert) | Topps Chrome / 2024 | NONE |  |  | ❌ NONE |
| 7 | `attached_assets/manaea_back_2024_topps_series2.jpg` | Topps / 2024 / Series 2 (base) | Topps / 2024 / Series Two / #380 | TOP | 0.06 | first-line-digit | ✅ TOP |
| 8 | `attached_assets/rafaela_back_2024_topps_smlb.jpg` | Topps / 2024 / Stars of MLB (insert) | Topps / 2024 / #SMLB-48 | TOP | 0.15 | dash-number | ✅ TOP |
| 9 | `attached_assets/trout_back_2024_topps_chrome.jpg` | Topps / 2024 / Chrome (base) | Topps Chrome / 2024 | NONE |  |  | ❌ NONE |
| 10 | `attached_assets/Eric_Davis_Back_1770591274413.jpeg` | Topps / 1987 / Topps (base) | Score / Rifleman / #696 | RELAXED | 0.93 | standalone-line-number | ❌ RELAXED |
| 11 | `uploads/george_frazier_back_1987_topps.jpg` | Topps / 1987 / Topps (base) | Topps / 1987 / #207 | TOP | 0.09 | first-line-leading-digit | ✅ TOP |
| 12 | `uploads/1745782254523_Trout_back.jpg` | Trout (unknown) | Topps Chrome / 2024 | NONE |  |  | ❌ NONE |
| 13 | `uploads/1745785721128_Machado_back.jpg` | Machado (unknown) | Topps Chrome / 2024 | NONE |  |  | ❌ NONE |
| 14 | `uploads/1745790593497_Volpe_back.jpg` | Volpe (unknown) | Topps / 2024 / #SMLB-76 | RELAXED | n/a | dash-number | ❌ RELAXED |
| 15 | `uploads/1745791833113_Schanuel_back.jpg` | Schanuel (unknown) | Topps / 2024 / #SMLB-73 | RELAXED | n/a | dash-number | ❌ RELAXED |
| 16 | `uploads/1745792025510_Lewis_back.jpg` | Lewis (unknown) | Topps / 2024 / #SMLB-69 | RELAXED | n/a | dash-number | ❌ RELAXED |
| 17 | `uploads/1745796442086_Rutschman_back.jpg` | Rutschman (unknown) | Topps / 2024 / #SMLB-66 | RELAXED | n/a | dash-number | ❌ RELAXED |
| 18 | `uploads/1745796845936_Bregman_back.jpg` | Bregman (unknown) | Topps / 2024 / #SMLB-59 | RELAXED | n/a | dash-number | ❌ RELAXED |
| 19 | `uploads/1745797140221_Gray_back.jpg` | Gray (unknown) | Topps / 2024 / #SMLB-58 | RELAXED | n/a | dash-number | ❌ RELAXED |
| 20 | `uploads/1745841448392_Frelick_back.jpg` | Frelick (unknown) | Topps / 2024 / #SMLB-56 | RELAXED | n/a | dash-number | ❌ RELAXED |
| 21 | `uploads/1745841615206_Ohtani_back.jpg` | Ohtani (unknown) | Topps / 2024 / #SMLB-55 | RELAXED | n/a | dash-number | ❌ RELAXED |
| 22 | `uploads/1745867368012_Rafaela_back.jpg` | Rafaela (unknown) | Topps / 2024 / #SMLB-48 | RELAXED | n/a | dash-number | ❌ RELAXED |
| 23 | `uploads/1745871754347_Lindor_back.jpg` | Lindor (unknown) | Topps / 2024 / #SMLB-42 | RELAXED | n/a | dash-number | ❌ RELAXED |
| 24 | `uploads/1748117697572_Bell_back.jpg` | Bell (unknown) | Score / 1990 / Finest / #603 | TOP | 0.21 | first-line-digit | ✅ TOP |
| 25 | `uploads/1748121530952_Votto_back.jpg` | Votto (unknown) | Topps / 2024 / #ATH-21 | RELAXED | n/a | dash-number | ❌ RELAXED |
| 26 | `uploads/1748122748803_Bart_back.jpg` | Bart (unknown) | Topps / 2022 / Opening Day / #206 | TOP | 0.17 | nearby-number | ✅ TOP |
| 27 | `uploads/1748131671695_Tatis Jr._back.jpg` | Tatis Jr. (unknown) | Topps / 2024 / #CTC-10 | TOP | 0.14 | dash-number | ✅ TOP |
| 28 | `uploads/1748132924218_Acuña Jr._back.jpg` | Acuña Jr. (unknown) | Topps / 2021 / Series One / #I-MAKE | TOP | 0.40 | autograph-letter-letter | ✅ TOP |
| 29 | `uploads/1748134305937_Harper_back.jpg` | Harper (unknown) | Topps / 2024 / #139 | RELAXED | 0.42 | standalone-line-number | ❌ RELAXED |
| 30 | `uploads/1748135529471_Frazier_back.jpg` | Frazier (unknown) | Topps / 1987 / #207 | TOP | 0.09 | first-line-leading-digit | ✅ TOP |
| 31 | `uploads/1748179343897_Bergman_back.jpg` | Bergman (unknown) | Score / 1990 / #254 | TOP | 0.23 | first-line-digit | ✅ TOP |
| 32 | `uploads/1748186788506_Jones_back.jpg` | Jones (unknown) | Upper Deck / 1989 / #286 | RELAXED | 0.91 | first-line-digit | ❌ RELAXED |

## Misreads to investigate

Patterns observed in this sweep have already been filed as follow-up tasks:
- **#17** Detect SMLB / CSMLB-style Stars-of-MLB card numbers in the strict top-region pass
- **#18** Recognize card numbers printed at the bottom of vintage Topps backs
- **#19** Add an automated regression suite for the card-number OCR detector

### attached_assets/machado_back_2024_topps_csmlb.jpg
- Expected: Topps / 2024 / Chrome Stars of MLB
- Detected: brand=Topps Chrome, year=2024, set=, cardNumber=
- Region: **NONE**
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=3603, tokens=130
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
```
- Raw OCR snippet (first ~240 chars):
```
STARS OF MLB
SMLB-
MANNY MACHADO
SAN DIEGO PADREST | 3B
Manny has built his reputation for prolific
production over an impressive 12-year run
that has seen him regularly dispatch tape
measure bombs into the outfield seats and
deliver highli
```

### attached_assets/trout_back_2024_topps_chrome.jpg
- Expected: Topps / 2024 / Chrome
- Detected: brand=Topps Chrome, year=2024, set=, cardNumber=
- Region: **NONE**
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=3362, tokens=136
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
```
- Raw OCR snippet (first ~240 chars):
```
STARS OF MLB
CSMLB-2
MIKE TROUT
ANGELS® I OF
Mike's first decade ranks among the elite.
He finished in the top five of the American
League MVP Award balloting in each of his
first nine full seasons, setting an MLB record.
With a career aver
```

### attached_assets/Eric_Davis_Back_1770591274413.jpeg
- Expected: Topps / 1987 / Topps
- Detected: brand=Score, year=0, set=Rifleman, cardNumber=696
- Region: **RELAXED**, normY=0.93, source=standalone-line-number
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=1070, tokens=77
[CardNum-pos] Rejecting "696" via standalone-line-number (side=back) at normY=0.93 (BOTTOM) — not in top 40%
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "696" via standalone-line-number (side=back, relaxed pass, normY=0.93, BOTTOM)
```
- Raw OCR snippet (first ~240 chars):
```
RIFLEMAN
ERIC DAVIS
Most of the focus on Enc concerns his strong hitting
and his skillful base stealing But this multi-talented
athlete also is one of the finest outfielders in base-
ball. He covers an immense amount of ground with
dazzling
```

### uploads/1745782254523_Trout_back.jpg
- Expected: Trout
- Detected: brand=Topps Chrome, year=2024, set=, cardNumber=
- Region: **NONE**
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=3362, tokens=136
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
```
- Raw OCR snippet (first ~240 chars):
```
STARS OF MLB
CSMLB-2
MIKE TROUT
ANGELS® I OF
Mike's first decade ranks among the elite.
He finished in the top five of the American
League MVP Award balloting in each of his
first nine full seasons, setting an MLB record.
With a career aver
```

### uploads/1745785721128_Machado_back.jpg
- Expected: Machado
- Detected: brand=Topps Chrome, year=2024, set=, cardNumber=
- Region: **NONE**
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=3603, tokens=130
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
```
- Raw OCR snippet (first ~240 chars):
```
STARS OF MLB
SMLB-
MANNY MACHADO
SAN DIEGO PADREST | 3B
Manny has built his reputation for prolific
production over an impressive 12-year run
that has seen him regularly dispatch tape
measure bombs into the outfield seats and
deliver highli
```

### uploads/1745790593497_Volpe_back.jpg
- Expected: Volpe
- Detected: brand=Topps, year=2024, set=, cardNumber=SMLB-76
- Region: **RELAXED**, normY=n/a, source=dash-number
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2791, tokens=137
[CardNum-pos] Skipping "SMLB-76" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "SMLB-76" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-76" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
- Raw OCR snippet (first ~240 chars):
```
STARS OF MLB
SMLB-76
ANTHONY VOLPE
NEW YORK YANKEES® ISS
Anthony entered rarefied air as only the
second Yankees shortstop to win a fielding
award, joining his idol, Derek Jeter. Volpe,
who was born in Manhattan, did it as a rookie,
complem
```

### uploads/1745791833113_Schanuel_back.jpg
- Expected: Schanuel
- Detected: brand=Topps, year=2024, set=, cardNumber=SMLB-73
- Region: **RELAXED**, normY=n/a, source=dash-number
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2729, tokens=133
[CardNum-pos] Skipping "SMLB-73" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Rejecting "ON-BASE" via autograph-letter-letter (side=back) at normY=0.51 (MIDDLE) — not in top 40%
[CardNum-pos] Skipping "SMLB-73" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-73" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
- Raw OCR snippet (first ~240 chars):
```
STARS OF MLB
SMLB-73
NOLAN SCHANUEL
ANGELS® | 1B
A scoring change early in 2024 retroactively
ended Nolan's on-base streak at 30 games,
but that was still the fourth-longest streak
to start a career behind Alvin Davis (47) and
Truck Hannah 
```

### uploads/1745792025510_Lewis_back.jpg
- Expected: Lewis
- Detected: brand=Topps, year=2024, set=, cardNumber=SMLB-69
- Region: **RELAXED**, normY=n/a, source=dash-number
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2724, tokens=132
[CardNum-pos] Skipping "SMLB-69" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "SMLB-69" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-69" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
- Raw OCR snippet (first ~240 chars):
```
STARS OF MLB
SMLB-69
ROYCE LEWIS
MINNESOTA TWINSⓇ 13B
Royce has a knack for hitting the longball,
especially with the bases loaded. Minnesota's
former number one overall draft pick walloped
four grand slams in an 18-game stretch in
2023, th
```

### uploads/1745796442086_Rutschman_back.jpg
- Expected: Rutschman
- Detected: brand=Topps, year=2024, set=, cardNumber=SMLB-66
- Region: **RELAXED**, normY=n/a, source=dash-number
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2575, tokens=131
[CardNum-pos] Skipping "SMLB-66" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "SMLB-66" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-66" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
- Raw OCR snippet (first ~240 chars):
```
STARS OF MLB
SMLB-66
ADLEY RUTSCHMAN
BALTIMORE ORIOLES® 1 C
Adley's arrival almost immediately heralded
a new era of Orioles baseball as a contender,
with the backstop serving as a foundational
piece whose presence is felt at bat and in
the
```

### uploads/1745796845936_Bregman_back.jpg
- Expected: Bregman
- Detected: brand=Topps, year=2024, set=, cardNumber=SMLB-59
- Region: **RELAXED**, normY=n/a, source=dash-number
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2669, tokens=136
[CardNum-pos] Skipping "SMLB-59" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "SMLB-59" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-59" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
- Raw OCR snippet (first ~240 chars):
```
STARS OF MLB
SMLB-59
ALEX BREGMAN
HOUSTON ASTROS 13B
Alex finds new ways to impress, even with two
championship rings and two MLB All-Star Game
selections to his name. He posted 25 HRs and 98
RBI in a career-high 161 games in 2023. "He just
```

### uploads/1745797140221_Gray_back.jpg
- Expected: Gray
- Detected: brand=Topps, year=2024, set=, cardNumber=SMLB-58
- Region: **RELAXED**, normY=n/a, source=dash-number
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2598, tokens=143
[CardNum-pos] Skipping "SMLB-58" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Rejecting "YEAR-OLD" via autograph-letter-letter (side=back) at normY=0.59 (MIDDLE) — not in top 40%
[CardNum-pos] Skipping "SMLB-58" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-58" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
- Raw OCR snippet (first ~240 chars):
```
STARS OF MLB
SMLB-58
SONNY GRAY
ST. LOUIS CARDINALS I P
Sonny has found the fountain of youth, thanks
to his intense offseason workout regimen. In
2023, the 33-year-old enjoyed his best season
in a decade, posting a 2.79 ERA and 183 SOs
in 
```

### uploads/1745841448392_Frelick_back.jpg
- Expected: Frelick
- Detected: brand=Topps, year=2024, set=, cardNumber=SMLB-56
- Region: **RELAXED**, normY=n/a, source=dash-number
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2760, tokens=137
[CardNum-pos] Skipping "SMLB-56" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "SMLB-56" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-56" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
- Raw OCR snippet (first ~240 chars):
```
STARS OF MLB
SMLB-56
SAL FRELICK
MILWAUKEE BREWERS I OF
Sal displayed an inviting combination of
power, speed and impeccable outfield defense
as a rookie in 2023. He finished with 24 RBI in
57 games and helped lead the Brewers to a
division
```

### uploads/1745841615206_Ohtani_back.jpg
- Expected: Ohtani
- Detected: brand=Topps, year=2024, set=, cardNumber=SMLB-55
- Region: **RELAXED**, normY=n/a, source=dash-number
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2809, tokens=139
[CardNum-pos] Skipping "SMLB-55" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Rejecting "TWO-WAY" via autograph-letter-letter (side=back) at normY=0.79 (BOTTOM) — not in top 40%
[CardNum-pos] Skipping "SMLB-55" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Rejecting "2" via standalone-line-number (side=back) at normY=0.77 (BOTTOM) — not in top 40%
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-55" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
- Raw OCR snippet (first ~240 chars):
```
STARS OF MLB.
SMLB-55
SHOHEI OHTANI
LOS ANGELES DODGERS® I P/DH
Shohei dons Dodger Blue in 2024, bringing his
two-way excellence to a franchise known for
great pitchers and sluggers. Ohtani won his
second AL MVP Award in 2023 after clubbing
```

### uploads/1745867368012_Rafaela_back.jpg
- Expected: Rafaela
- Detected: brand=Topps, year=2024, set=, cardNumber=SMLB-48
- Region: **RELAXED**, normY=n/a, source=dash-number
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2743, tokens=132
[CardNum-pos] Skipping "SMLB-48" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "SMLB-48" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-48" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
- Raw OCR snippet (first ~240 chars):
```
STARS OF MLB
SMLB-48
CEDDANNE RAFAELA
BOSTON RED SOX® I OF
Instinctual with a penchant for game-changing
plays, Ceddanne made quite an entrance into
the big leagues in 2023. In 28 games, Rafaela
flashed the power and speed combination
that 
```

### uploads/1745871754347_Lindor_back.jpg
- Expected: Lindor
- Detected: brand=Topps, year=2024, set=, cardNumber=SMLB-42
- Region: **RELAXED**, normY=n/a, source=dash-number
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2749, tokens=130
[CardNum-pos] Skipping "SMLB-42" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "SMLB-42" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-42" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
- Raw OCR snippet (first ~240 chars):
```
STARS OF MLB
SMLB-42
FRANCISCO LINDOR
NEW YORK METS® ISS
Francisco finished ninth in NL MVP voting
for the second straight year after another
stellar campaign in 2023. The prolific switch-
hitter racked up 31 home runs and 98 RBI
while logg
```

### uploads/1748121530952_Votto_back.jpg
- Expected: Votto
- Detected: brand=Topps, year=2024, set=, cardNumber=ATH-21
- Region: **RELAXED**, normY=n/a, source=dash-number
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2767, tokens=130
[CardNum-pos] Skipping "ATH-21" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "ATH-21" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "ATH-21" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
- Raw OCR snippet (first ~240 chars):
```
ATH-21
JOEY VOTTO
CINCINNATI REDS Ⓡ
FIRST BASEMAN
Joey's been a mainstay during his
17 seasons with Cincinnati, where he
established a Reds record for a first
baseman with 136 assists in 2008, then
topped that mark in 2011 with a big-
leagu
```

### uploads/1748134305937_Harper_back.jpg
- Expected: Harper
- Detected: brand=Topps, year=2024, set=, cardNumber=139
- Region: **RELAXED**, normY=0.42, source=standalone-line-number
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2721, tokens=314
[CardNum-pos] Rejecting "139" via standalone-line-number (side=back) at normY=0.42 (MIDDLE) — not in top 40%
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "139" via standalone-line-number (side=back, relaxed pass, normY=0.42, MIDDLE)
```
- Raw OCR snippet (first ~240 chars):
```
8982-11
BRYCE
RYCE HARPER
<- OUTFIELD
PHILADELPHIA PHILLIES®
HT: 6'3" WT: 210 lb. BATS: LEFT THROWS: RIGHT DRFTD: NATIONALS #1-JUNE, 2010
ACQ: FREE AGENT, 3-1-19 BORN: 10-16-92, LAS VEGAS, NEV. HOME: LAS VEGAS, NEV.
COMPLETE MAJOR LEAGUE BA
```

### uploads/1748186788506_Jones_back.jpg
- Expected: Jones
- Detected: brand=Upper Deck, year=1989, set=, cardNumber=286
- Region: **RELAXED**, normY=0.91, source=first-line-digit
- [CardNum*] log lines:
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2598, tokens=109
[CardNum-pos] Rejecting "286" via first-line-digit (side=back) at normY=0.91 (BOTTOM) — not in top 40%
[CardNum-pos] Rejecting "286" via first-line-number (side=back) at normY=0.91 (BOTTOM) — not in top 40%
[CardNum-pos] Rejecting "286" via top-3-lines (side=back) at normY=0.91 (BOTTOM) — not in top 40%
[CardNum-pos] Rejecting "286" via standalone-line-number (side=back) at normY=0.91 (BOTTOM) — not in top 40%
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "286" via first-line-digit (side=back, relaxed pass, normY=0.91, BOTTOM)
```
- Raw OCR snippet (first ~240 chars):
```
286
P • PADRES
Jones
Jimmy
B: 4-20-64, Dallas, TX
H: 6-2 W: 190 B: RT: R
YR TEAM
W L ERA
G GS CG SHO SV IP
H
BB SO
86
PADRES
2 0 2.50
3
3
87 PADRES
9 7 4.14
30
30
22
88 PADRES
9 14 4.12
29 29
123
1 0 18
1 0 146
10
10
3 15
154 54
51
300 179

```

## Full [CardNum*] log excerpts (every sample)

### attached_assets/bregman_back_2024_topps_35year.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=1645, tokens=262
[CardNum-pos] Accepting "89B2-32" via year-prefixed (side=back) at normY=0.08 (TOP)
```
### attached_assets/cole_back_2021_topps_heritage.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2011, tokens=245
[CardNum-pos] Accepting "249" via first-line-digit (side=back) at normY=0.06 (TOP)
```
### attached_assets/correa_back_2024_topps_smlb.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=3495, tokens=131
[CardNum-pos] Accepting "SMLB-49" via dash-number (side=back) at normY=0.18 (TOP)
```
### attached_assets/freedman_back_2023_topps_smlb.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=3028, tokens=137
[CardNum-pos] Accepting "SMLB-27" via dash-number (side=back) at normY=0.07 (TOP)
```
### attached_assets/frelick_back_2024_35year.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=1397, tokens=288
[CardNum-pos] Accepting "89B-9" via year-prefixed (side=back) at normY=0.11 (TOP)
```
### attached_assets/machado_back_2024_topps_csmlb.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=3603, tokens=130
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
```
### attached_assets/manaea_back_2024_topps_series2.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=1895, tokens=305
[CardNum-pos] Accepting "380" via first-line-digit (side=back) at normY=0.06 (TOP)
```
### attached_assets/rafaela_back_2024_topps_smlb.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=3799, tokens=133
[CardNum-pos] Accepting "SMLB-48" via dash-number (side=back) at normY=0.15 (TOP)
```
### attached_assets/trout_back_2024_topps_chrome.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=3362, tokens=136
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
```
### attached_assets/Eric_Davis_Back_1770591274413.jpeg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=1070, tokens=77
[CardNum-pos] Rejecting "696" via standalone-line-number (side=back) at normY=0.93 (BOTTOM) — not in top 40%
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "696" via standalone-line-number (side=back, relaxed pass, normY=0.93, BOTTOM)
```
### uploads/george_frazier_back_1987_topps.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2705, tokens=231
[CardNum-pos] Accepting "207" via first-line-leading-digit (side=back) at normY=0.09 (TOP)
```
### uploads/1745782254523_Trout_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=3362, tokens=136
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
```
### uploads/1745785721128_Machado_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=3603, tokens=130
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
```
### uploads/1745790593497_Volpe_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2791, tokens=137
[CardNum-pos] Skipping "SMLB-76" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "SMLB-76" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-76" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
### uploads/1745791833113_Schanuel_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2729, tokens=133
[CardNum-pos] Skipping "SMLB-73" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Rejecting "ON-BASE" via autograph-letter-letter (side=back) at normY=0.51 (MIDDLE) — not in top 40%
[CardNum-pos] Skipping "SMLB-73" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-73" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
### uploads/1745792025510_Lewis_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2724, tokens=132
[CardNum-pos] Skipping "SMLB-69" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "SMLB-69" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-69" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
### uploads/1745796442086_Rutschman_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2575, tokens=131
[CardNum-pos] Skipping "SMLB-66" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "SMLB-66" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-66" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
### uploads/1745796845936_Bregman_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2669, tokens=136
[CardNum-pos] Skipping "SMLB-59" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "SMLB-59" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-59" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
### uploads/1745797140221_Gray_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2598, tokens=143
[CardNum-pos] Skipping "SMLB-58" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Rejecting "YEAR-OLD" via autograph-letter-letter (side=back) at normY=0.59 (MIDDLE) — not in top 40%
[CardNum-pos] Skipping "SMLB-58" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-58" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
### uploads/1745841448392_Frelick_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2760, tokens=137
[CardNum-pos] Skipping "SMLB-56" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "SMLB-56" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-56" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
### uploads/1745841615206_Ohtani_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2809, tokens=139
[CardNum-pos] Skipping "SMLB-55" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Rejecting "TWO-WAY" via autograph-letter-letter (side=back) at normY=0.79 (BOTTOM) — not in top 40%
[CardNum-pos] Skipping "SMLB-55" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Rejecting "2" via standalone-line-number (side=back) at normY=0.77 (BOTTOM) — not in top 40%
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-55" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
### uploads/1745867368012_Rafaela_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2743, tokens=132
[CardNum-pos] Skipping "SMLB-48" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "SMLB-48" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-48" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
### uploads/1745871754347_Lindor_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2749, tokens=130
[CardNum-pos] Skipping "SMLB-42" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "SMLB-42" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "SMLB-42" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
### uploads/1748117697572_Bell_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2658, tokens=232
[CardNum-pos] Accepting "603" via first-line-digit (side=back) at normY=0.21 (TOP)
```
### uploads/1748121530952_Votto_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2767, tokens=130
[CardNum-pos] Skipping "ATH-21" via dash-number (side=back) — no contiguous token position (strict pass)
[CardNum-pos] Skipping "ATH-21" via hyphen-alphanum-early (side=back) — no contiguous token position (strict pass)
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "ATH-21" via dash-number (side=back, relaxed pass, normY=n/a, UNKNOWN)
```
### uploads/1748122748803_Bart_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2590, tokens=287
[CardNum-pos] Accepting "206" via nearby-number (side=back) at normY=0.17 (TOP)
```
### uploads/1748131671695_Tatis Jr._back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2751, tokens=283
[CardNum-pos] Accepting "CTC-10" via dash-number (side=back) at normY=0.14 (TOP)
```
### uploads/1748132924218_Acuña Jr._back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2718, tokens=327
[CardNum-pos] Accepting "I-MAKE" via autograph-letter-letter (side=back) at normY=0.40 (TOP)
```
### uploads/1748134305937_Harper_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2721, tokens=314
[CardNum-pos] Rejecting "139" via standalone-line-number (side=back) at normY=0.42 (MIDDLE) — not in top 40%
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "139" via standalone-line-number (side=back, relaxed pass, normY=0.42, MIDDLE)
```
### uploads/1748135529471_Frazier_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2705, tokens=231
[CardNum-pos] Accepting "207" via first-line-leading-digit (side=back) at normY=0.09 (TOP)
```
### uploads/1748179343897_Bergman_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2604, tokens=274
[CardNum-pos] Accepting "254" via first-line-digit (side=back) at normY=0.23 (TOP)
```
### uploads/1748186788506_Jones_back.jpg
```
[CardNum-pos] Position-aware strict pass (side=back): imageHeight=2598, tokens=109
[CardNum-pos] Rejecting "286" via first-line-digit (side=back) at normY=0.91 (BOTTOM) — not in top 40%
[CardNum-pos] Rejecting "286" via first-line-number (side=back) at normY=0.91 (BOTTOM) — not in top 40%
[CardNum-pos] Rejecting "286" via top-3-lines (side=back) at normY=0.91 (BOTTOM) — not in top 40%
[CardNum-pos] Rejecting "286" via standalone-line-number (side=back) at normY=0.91 (BOTTOM) — not in top 40%
[CardNum-pos] No top-region card number found (side=back) — falling back to text-only relaxed pass
[CardNum] Accepting "286" via first-line-digit (side=back, relaxed pass, normY=0.91, BOTTOM)
```