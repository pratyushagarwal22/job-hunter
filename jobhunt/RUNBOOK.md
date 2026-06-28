# JOBHUNT Runbook (do not regress)

This file documents **critical invariants** in the JOBHUNT Command Center + Drive workflow so future changes don’t re-break dropdown validation, gated asset generation, or sheet hygiene.

## Scoring convention (Command Center)

- **`INBOX_RAW.match_score` / `SHORTLIST.match_score` are on a 0-10 scale** (decimals allowed).
- **`npm run jobhunt:seed-8`** uses demo scores in `jobhunt/match-score-demo.mjs` and promotes to **SHORTLIST** only when **`match_score >= E2E_PROMOTION_THRESHOLD`** (default **6.0**). Replace with a real scorer in production.

## Invariants (must hold)

### 1) `SHORTLIST.pursue` dropdown must work for seeded + newly appended rows

- **Goal**: Cells `SHORTLIST!B2:B` should have a dropdown with values:
  - `UNREVIEWED`, `PURSUE`, `HOLD`, `SKIP`
- **Important**: Google Sheets can shift/lose data-validation when rows are appended after validation is applied.
- **Rule**: Always (re)apply validation **after** inserting/appending rows to `SHORTLIST`.

**Where enforced**
- `integrations/google/sheets.mjs` — `reapplyShortlistPursueDropdown()` (shared helper)
- `jobhunt/command-center-bootstrap.mjs` — calls that helper after sizing tabs
- `jobhunt/cleanup-test-data.mjs` — calls it after clearing tabs (so **B2** stays valid)
- `jobhunt/seed-shortlist-8.mjs` — calls it after all `SHORTLIST` appends

### 2) Do not “auto-set” `pursue` during seed / Stage 1

- Ingestion / scoring must leave **`SHORTLIST.pursue` blank** so the user selects via dropdown.
- Do not write `pursue` unless doing an explicit migration/repair task.

### 3) Stage 2 asset generation must be idempotent

- Re-running Stage 2 must **not** duplicate `ASSETS` rows or re-create Drive files for the same `job_id`.
- **Rule**: Stage 2 must check whether an `ASSETS` row already exists for `job_id` before creating anything.

**Where enforced**
- `jobhunt/stage2-generate-assets.mjs` builds a Set of existing `ASSETS.job_id` and skips those.

### 4) Cleanup must preserve sheet grids

- Cleanup must keep headers and **must not shrink** sheet grids (shrinking breaks open-ended validations).
- **Rule**: Clear values from row 2 onward, don’t delete rows.
- After clearing, **`SHORTLIST!B2:B` pursue validation is re-applied** so row 2 shows the dropdown.

**Where enforced**
- `integrations/google/sheets.mjs` `clearTabExceptHeader()` clears `A2:ZZ` values only.
- `jobhunt/cleanup-test-data.mjs` calls `reapplyShortlistPursueDropdown()` after tab clears.

## Canonical end-to-end test (Sheets + Drive assets only)

This is the **single** supported path to validate Command Center behavior (not LaTeX / master resume PDF — those stay separate).

```bash
npm run jobhunt:cleanup
npm run jobhunt:bootstrap
npm run jobhunt:seed-8
```

Expected:

1. **10** rows on **`INBOX_RAW`** with varied **`match_score`** (demo map).
2. **SHORTLIST** only for jobs with **score ≥ 6.0** (5 rows with the current fixture set).
3. **JDS** + **CONTEXT** files in Drive for all 10 jobs; **no** `ASSETS` tab rows yet.

Then:

1. Set **`SHORTLIST.pursue`** (e.g. `PURSUE`) for the rows you want.
2. Run **`npm run jobhunt:stage2`** — placeholder **RESUME** / **COVERLETTER** / **EMAIL** files and **`ASSETS`** + **`PIPELINE_STATUS`** updates for those rows only.
3. Change **pursue** or add new shortlist rows and run **`npm run jobhunt:stage2`** again — existing `job_id`s must not duplicate in **`ASSETS`**.

Same entry point: **`npm run jobhunt:e2e`** (alias of **`seed-8`**).

## Claude API (smoke test)

After **`ANTHROPIC_API_KEY`** is in **`.env`** (see **`.env.example`**):

```bash
cd career-ops
npm install   # once, if @anthropic-ai/sdk is not installed yet
npm run jobhunt:claude-ping
```

That is the same as `node jobhunt/claude-ping.mjs` from the repo root; the npm script is only a short alias. Success prints JSON with `"ok": true` and a short model reply. Optional: **`ANTHROPIC_MODEL`** overrides the ping default (`claude-haiku-4-5`).

## AI test path (URLs → JD text → Claude scores) — **separate** from seed-8 / stage2

Does **not** modify the Command Center e2e flow. Uses Playwright to open **public job URLs**, extracts visible text, calls Claude with **`ANTHROPIC_MODEL_SCORE`** (see **`integrations/anthropic/config.mjs`** for defaults and **`ANTHROPIC_MODEL_*`** overrides).

1. `cp jobhunt/ai-test/urls.example.txt jobhunt/ai-test/urls.txt` and add **8–10 URLs** (one per line).
2. Install browser once: `npx playwright install chromium`
3. Optional: `npm run jobhunt:ai-verify-models` — confirms all six per-task model ids work (or defaults): **`ANTHROPIC_MODEL_{SCORE,LINKEDIN,RESUME,RESUME_SUMMARY,OUTREACH,COVER_LETTER}`** (see **`integrations/anthropic/config.mjs`**).
4. Run: **`npm run jobhunt:ai-score-urls`** — writes **`jobhunt/ai-test/output/last-report.json`** (gitignored). Each scored row includes:
   - `match_score` (0–10), `rationale`, `page_quality`
   - **`company`**, **`role`** (AI-extracted from the scraped JD text)
   - **`role_family`** (`SWE|ANALYST|PM|OTHER`)
   - **`min_years_experience`**, **`max_years_experience`** (numbers or `null`)

Some employers block headless fetch or require login; **`page_quality`** in the report hints at bad extractions. Prefer public ATS job links when you can.

After changing **`config/profile.yml`** (e.g. SWE scoring rules), re-run **`npm run jobhunt:ai-score-urls`** so **`last-report.json`** reflects the new instructions, then:

**Push scores + JD files into Command Center + Drive**

1. `npm run jobhunt:ai-sync-sheets` — reads **`jobhunt/ai-test/output/last-report.json`**, skips URLs already in **`INBOX_RAW`**, uploads **JDS** + **CONTEXT**, appends **INBOX_RAW**, promotes to **SHORTLIST** when **score ≥ 6.0**, reapplies **pursue** dropdown. It prefers AI-extracted `company`/`role` and falls back to parsing `page_title` only when missing.
2. In the sheet, set **`SHORTLIST.pursue`** as needed.
3. `npm run jobhunt:stage2` — requires **`ANTHROPIC_API_KEY`**; downloads each **JD** from Drive, then Claude generates **`.tex` resume**, formatted **cover letter** (team-directed), and an **outreach email template** + **LinkedIn invite template** (both person-directed, using `Hi [Name],`). Compile **`.tex`** locally (see `templates/cv-template.tex`). Review all copy before sending.

### Scoring rules (AI test path)

In addition to the general fit assessment, the URL scorer applies these score-floor rules (defined in **`jobhunt/lib/scoring-prompt.mjs`**, synced with **`config/profile.yml`** → `ai_evaluation`):

- **SWE early-career rule**: for clearly entry-level SWE roles (0–3 years / new grad / "new grads ok"), keep `match_score >= 6` unless hard blockers apply; only score < 6 when the JD clearly requires >3 years AND is mid-level+.
- **Cloud / data-platform / applied-AI SWE rule**: for `role_family="SWE"` on cloud infrastructure, data platform, analytics infrastructure, distributed systems for data, ML/data serving, or applied AI/LLM teams, keep `match_score >= 6` unless hard blockers apply (clearance, authorization).
- **FDE rule**: for Forward Deployed Engineer roles with a coding bar, keep `match_score >= 6` unless hard blockers apply.
- **Startup / founding / product-engineering rule**: for Founding Engineer, Founding Product Engineer, or Product Engineer at startups (e.g. workatastartup.com) when "new grads ok" or no explicit >3 year bar, keep `match_score >= 6` unless hard blockers apply.
- **Location rule**: geography is **never** a scoring penalty (US, West Coast, international, or onsite/hybrid). **Greater Seattle area** gets a **+0.25–0.5 bonus**; **US West Coast** (WA/OR/CA) up to **+0.25**; onsite at startups is expected and fine.
- **Analyst big-tech rule**: for `role_family="ANALYST"` at a company listed in `config/priority-companies.yml`, if the JD requires **3–5 years** experience, then `match_score >= 6`.
- **PM early-career rule**: for `role_family="PM"` roles that are clearly early-career (APM / apprentice / early career / 0–2 years), then `match_score >= 6`.

> **JSON parsing of Claude responses (scoring + Stage 2 assets)** is centralized
> in **`jobhunt/lib/claude-json.mjs`**. See [Claude JSON contract](#claude-json-contract)
> below for the contract, failure modes, and how to extend it for Stage 1.

## Claude JSON contract

Every Claude prompt in this repo that expects a structured response (the
URL scorer, Stage 2 resume / outreach / LinkedIn generators, and the future
**Stage 1** that will replace `ai-score-urls` + `ai-sync-sheets` with a
direct `config/portals.yml → INBOX_RAW/SHORTLIST` ingest) instructs the model to
emit **a single JSON object** as its reply. The model's actual output, in
practice, can still arrive in any of these shapes:

- bare object: `{"match_score": 6.5, ...}`
- fenced object: ```` ```json\n{...}\n``` ````
- object surrounded by prose: `Sure! {...} hope this helps.`
- object whose string values contain `}`, `\"`, or other punctuation that
  used to confuse the old `indexOf('{') ... lastIndexOf('}')` slicer.

### The single shared parser

All callers MUST go through **[`jobhunt/lib/claude-json.mjs`](lib/claude-json.mjs)**:

- `extractJsonObject(text)` — fence-strips, then walks the input one `{`
  at a time, tracking brace depth while honoring string literals and
  `\\` / `\"` escapes. Returns the first balanced + `JSON.parse`-able
  object, or `null`.
- `stripMarkdownCodeFence(text)` — removes a leading ``` ```/```json/```text/```plaintext ```
  fence and matching trailing fence; idempotent on unfenced input.

Current consumers:

- [`jobhunt/ai-test/score-from-urls.mjs`](ai-test/score-from-urls.mjs) (URL scorer)
- [`jobhunt/lib/claude-asset-generators.mjs`](lib/claude-asset-generators.mjs)
  — Stage 2 resume, outreach email, and LinkedIn invite generators

**Stage 1** (the planned `config/portals.yml`-driven ingestion that supersedes
`ai-score-urls` / `ai-sync-sheets`) will reuse this same util — do not
re-introduce a local copy. If a new caller needs additional tolerance
(e.g. JSON arrays at the top level), add it here, not in the caller.

### Failure-mode contract

| Input                                              | `extractJsonObject` returns | Caller responsibility |
| -------------------------------------------------- | --------------------------- | --------------------- |
| Markdown-fenced object (with or without `json` tag) | parsed object               | use as-is             |
| Object preceded or followed by prose                | parsed object               | use as-is             |
| Object whose string value contains `}` or escaped quotes | parsed object         | use as-is             |
| Truncated mid-string output (no balanced closing brace) | `null`                  | surface `ok:false` so the row is skipped on sync |
| Genuinely malformed JSON (unquoted keys, trailing commas) | `null`                | surface `ok:false`    |
| Empty / `null` / `undefined`                       | `null`                      | surface `ok:false`    |

Production callers must treat a `null` return as a hard failure for that
row and record it on the report (the URL scorer already does this; do not
silently default-score).

### Tests

[`scripts/diagnostics/claude-json-smoke.mjs`](../scripts/diagnostics/claude-json-smoke.mjs)
covers the cases above plus nested objects and the original Palo Alto
fenced shape. Run from `career-ops/`:

```bash
node scripts/diagnostics/claude-json-smoke.mjs
```

Exit 0 = all fixtures pass. Add a new fixture here whenever a real Claude
response surfaces a parsing edge case.

## Stage 3 — Contact discovery + `CONTACTS_MASTER` outreach drafts

`npm run jobhunt:stage3` runs **after** Stage 2 has generated `ASSETS` for the
PURSUE jobs you care about. It enriches **only** `CONTACTS_MASTER` (source of
truth) and writes per-contact email + LinkedIn invite drafts to Drive — **never
sends**.

Stage 3 is template-driven (no job-specific per-contact Claude calls by
default), which keeps the run fast and predictable.

### Prerequisites

- **`APOLLO_API_KEY`** in `.env` — must come from a paid plan (Basic and up).
  Apollo blocks every `/v1/...` API endpoint with HTTP 403 on the free tier.
- A recent **`npm run jobhunt:stage2`** run so `ASSETS.email_drive_link`,
  `ASSETS.linkedin_invite_text`, `ASSETS.jd_drive_link`, and
  `ASSETS.resume_summary` exist for each PURSUE row.
- Optional: edit [config/priority-companies.yml](../config/priority-companies.yml)
  to bump per-kind caps for specific companies. Match is case-insensitive on
  `name`; `domain` (when present) overrides the auto-guessed Apollo domain.
- Sheet schema: `CONTACTS_MASTER` is the sole contact source of truth. The
  schema lives in [jobhunt/command-center-schema.mjs](command-center-schema.mjs).
  - **`npm run jobhunt:bootstrap`** rewrites only row 1 to that schema (no-op
    when already correct).
  - **`npm run jobhunt:cleanup`** clears data rows (`A2:ZZ`) only — never the
    header row, never the local `career-ops/data/` folder. The Stage 3 dumps
    described below survive a cleanup.

### What it does

1. Read **`SHORTLIST`** for `pursue == 'PURSUE'` rows and the existing
   `CONTACTS_MASTER` for dedup.
2. For each job: resolve a primary domain (priority-yaml override → naive
   `companyname.com` guess) — no `/organizations/enrich` call.
3. **Discovery (credit-free):** call Apollo `/v1/mixed_people/api_search`
   twice per company:
   - **Recruiter pass** — `person_titles[]` from
     [integrations/apollo/taxonomy.mjs](../integrations/apollo/taxonomy.mjs)
     `RECRUITER_TITLES`, plus `person_locations[]` and `contact_email_status[]`
     filters. Paginated up to the per-kind cap.
   - **Hiring-manager pass** — `person_titles[]` from
     `roleToHmTitleKeywords(role)` ∧ `person_seniorities[]` from
     `HM_SENIORITIES`. Same locations/email-status filters, same pagination
     cap.
4. **Dedup vs `CONTACTS_MASTER`** in this priority order:
   1. `apollo_person_id` (parsed out of `CONTACTS_MASTER.notes`)
   2. `linkedin_url` (lowercased)
   3. `email` (lowercased)
   Existing master rows are reused; only net-new survivors get a fresh
   `CT-<YYYYMMDD>-<8-hex>`.
5. **Email reveal (credit-metered):** for net-new survivors only (known
   contacts skip `bulk_match`), call `/v1/people/bulk_match` in batches of 10
   (≈ 1 credit per net-new email).
6. **Per-contact drafts:** for every contact, Stage 3 can create Drive drafts
   under `OUTREACH/<COMPANY>/<ROLE_TYPE>/<person_email>/...` (when drafts are
   enabled) and store the Drive link + LinkedIn text in `CONTACTS_MASTER`.
7. Upserts **`CONTACTS_MASTER`** rows (append new or update existing).

### Tunables (env)

All defaults are baked into the script — set these only when you want to
deviate. See [`.env.example`](../.env.example) for the canonical list.

| Var | Default | Purpose |
|-----|---------|---------|
| `JOBHUNT_STAGE3_ENRICH_ONLY` | `1` | Skip per-contact Claude calls; reuse Stage 2 body. Setting `0` errors out — per-contact personalization isn't wired in this build. |
| `JOBHUNT_STAGE3_PER_KIND_DEFAULT_MAX` | `40` | Pagination cap per kind when `PER_COMPANY_TOTAL_MAX=0` (non-priority companies). |
| `JOBHUNT_STAGE3_PER_KIND_PRIORITY_MAX` | `80` | Pagination cap per kind when `PER_COMPANY_TOTAL_MAX=0` (priority companies). |
| `JOBHUNT_STAGE3_PER_COMPANY_TOTAL_MAX` | `50` | Combined cap per company in `CONTACTS_MASTER`; bidirectional recruiter/HM fill with partial OK. Set `0` to revert to per-kind caps (40/80). |
| `JOBHUNT_STAGE3_PER_KIND_MIN` | `2` | Soft floor; warns when Apollo returns fewer than this for a kind. |
| `JOBHUNT_APOLLO_PERSON_LOCATIONS` | `United States,USA,United States of America,US` | `person_locations[]` filter on api_search. |
| `JOBHUNT_APOLLO_CONTACT_EMAIL_STATUS` | `verified,likely to engage` | `contact_email_status[]` filter on api_search. |
| `JOBHUNT_APOLLO_BULK_MATCH_BATCH` | `10` | Apollo's hard cap for `/people/bulk_match`. |
| `JOBHUNT_APOLLO_REVEAL_PERSONAL_EMAILS` | `0` | `1` = include personal-email reveals (extra credits + GDPR considerations). |
| `JOBHUNT_STAGE3_DUMP_DIR` | `data/stage3` | Per-run JSON dump directory (relative to `career-ops/`). |
| `JOBHUNT_SNAPSHOTS_DIR` | `data/snapshots` | `CONTACTS_MASTER` JSON snapshots: per-run history + rolling `contacts-master-latest.json` (relative to `career-ops/`). |
| `JOBHUNT_STAGE3_LIMIT` | unset | Cap PURSUE rows per run (e.g. `1` for a dry-run). Failures count toward the cap. |
| `JOBHUNT_REGENERATE_CONTACTS` | unset | Legacy (no longer used). |

**Deprecated** (still parsed for backward compatibility, but ignored when
`config/priority-companies.yml` exists):
`JOBHUNT_STAGE3_PER_KIND_MAX` (renamed to
`JOBHUNT_STAGE3_PER_KIND_DEFAULT_MAX`),
`JOBHUNT_STAGE3_BIGCO_EMPLOYEE_THRESHOLD` (replaced by the priority-yaml
heuristic so Stage 3 never has to call `/organizations/enrich`).

### Pre-run backup (no Apollo credits)

Before a large Stage 3 run, snapshot the live sheet:

```bash
npm run jobhunt:dump-contacts-master
```

Writes `data/snapshots/contacts-master-<runId>.json`, updates
`contacts-master-latest.json`, and a slim `contacts-emails-<runId>.json`.

### Recommended dry-run on a fresh setup

```bash
JOBHUNT_STAGE3_LIMIT=1 npm run jobhunt:stage3
```

Inspect:

- **Sheet:** `CONTACTS_MASTER` rows are appended/updated and contain outreach
  draft fields when drafts are enabled.
- **Drive:** `OUTREACH/<COMPANY>/<ROLE_TYPE>/<person_email>/...` draft files
  exist when drafts are enabled.
- **Disk:** `CONTACTS_MASTER` snapshots live under `career-ops/data/snapshots/`.

### Local dumps (`career-ops/data/stage3/<runId>/`)

`runId` is `YYYYMMDD-HHMMSS`. Per run we write:

- **`run-summary.json`** — totals, env knobs, list of processed `job_id`s,
  errors, and warnings.
- **`<job_id>-search.json`** — every person discovered by `api_search`
  (recruiter + HM passes, deduped within the job), with `apollo_person_id`,
  `name`, `first_name`, `title`, `seniority`, `departments`, `linkedin_url`,
  `organization`, `kind`, `email_status_in_search`.
- **`<job_id>-bulkmatch.json`** — only the people we attempted to enrich, with
  `email`, `email_status`, `email_confidence`, `matched`, and (for fallbacks)
  `source: 'people/match-fallback'`.
- **`<job_id>-contacts-rows.json`** — legacy artifact from the old `CONTACTS`
  sheet flow (CONTACTS tab removed). Kept only for backward-compatibility when
  reading old run folders.

The whole tree is gitignored (`career-ops/.gitignore` adds `data/stage3/`).
`cleanup-test-data.mjs` does **not** touch `data/`, so dumps survive a sheet
cleanup.

### CONTACTS_MASTER snapshots (`career-ops/data/snapshots/`)

At the end of each Stage 3 run (after a successful `CONTACTS_MASTER` read), we
write:

- **`contacts-master-<runId>.json`** — immutable history; same `runId` as
  `data/stage3/<runId>/` (`YYYYMMDD-HHMMSS`).
- **`contacts-master-latest.json`** — copy of the most recent successful
  snapshot; stable path for rebuilds.

Snapshots are **not** stored under `data/stage3/<runId>/`, so a Stage 3 run
that exits early (new run folder but no snapshot) cannot block the next
`rebuild-contacts-master` from finding data.

This directory is gitignored (`career-ops/.gitignore` adds `data/snapshots/`).

### Rebuilding CONTACTS_MASTER after cleanup

If you ran `cleanup` and want to preserve Stage 3 dedup (so we don’t re-spend
Apollo credits re-revealing emails for already-known contacts), rebuild
`CONTACTS_MASTER` from the latest on-disk snapshot.

`rebuild-contacts-master-from-disk.mjs` resolves the snapshot in this order:
`data/snapshots/contacts-master-latest.json`, then the newest
`data/snapshots/contacts-master-<runId>.json`, then legacy
`data/stage3/<runId>/contacts-master-snapshot.json` (for trees produced before
this layout).

```bash
npm run jobhunt:cleanup && npm run jobhunt:bootstrap
npm run jobhunt:rebuild-contacts-master
```

Then run Stage 3 normally:

```bash
npm run jobhunt:stage3
```

### Apollo cost notes (basic plan steady state)

- **Discovery (`/v1/mixed_people/api_search`)** — 0 credits. Each company
  costs 2 calls (recruiter pass + HM pass), with up to ~1 page each at the
  default cap of 40, so a typical run is light. Pagination tops out at
  `per_page=100, page<=500` per Apollo.
- **Email reveal (`/v1/people/bulk_match`)** — ~1 credit per net-new email.
  We only attempt reveals for people who weren't already in
  `CONTACTS_MASTER`, in batches of 10. Personal-email reveals are off by
  default; flip `JOBHUNT_APOLLO_REVEAL_PERSONAL_EMAILS=1` to include them
  (extra credits per match).
- **Single-person fallback (`/v1/people/match`)** — same ~1 credit per email.
  Used only when `bulk_match` failed to populate an email for a survivor.
- **Phone reveals** — never requested. We don't set `reveal_phone_number=true`
  anywhere, so no webhook is required.

There is no automatic credit gate; the script keeps requesting reveals until
Apollo returns `429` / out-of-credits, in which case the failure is caught
per-contact and surfaced in `jobs[].warnings`.

### Inspecting failures

The script prints a single JSON `report` to stdout (also written to
`run-summary.json`):

- `processed`, `skipped_no_assets`, `skipped_already_has_contacts`
- `contacts_created` vs `contacts_reused`
- `apollo_credits_estimated` — best-effort count of bulk_match + match calls
- `jobs[].warnings` — per-job non-fatal issues (bulk_match batch failed, kind
  below floor, Drive write failed, …)
- `errors` — per-job hard failures (the run continues to the next job)

`cleanup-test-data.mjs` clears `CONTACTS_MASTER` and other tabs; `data/stage3/`
dumps are kept on purpose so discovered contacts aren't lost.

## Stage 4 — LinkedIn profile import (manual list)

Stage 4 imports **manually curated** LinkedIn profile URLs from
`jobhunt/stage4/linkedin-profiles.txt` into `CONTACTS_MASTER`. It is a
**parallel workflow** to Stage 3 — Stage 3 is unchanged.

Two commands (run enrich, review dumps, then sync):

```bash
cp jobhunt/stage4/linkedin-profiles.example.txt jobhunt/stage4/linkedin-profiles.txt
# edit linkedin-profiles.txt — one LinkedIn URL per line

npm run jobhunt:stage4-enrich
# review data/stage4/<runId>/contacts-import.json and run-summary.json

npm run jobhunt:stage4-sync
# or: npm run jobhunt:stage4-sync -- <runId>
```

### What it does

1. **Enrich** — read live `CONTACTS_MASTER` for dedup; skip URLs already on the
   sheet (no Apollo credits). Call Apollo `bulk_match` (+ `people/match`
   fallback) for net-new URLs only. Write `data/stage4/<runId>/`:
   - `run-summary.json` — stats
   - `contacts-import.json` — incremental batch (`values[]` = header + net-new rows)
2. **Sync** — append net-new rows to `CONTACTS_MASTER` (never update existing).
   One sheet read; build full snapshot in memory (`existing + appended`). Write
   `data/snapshots/contacts-master-latest.json` and history copy.

### Prerequisites

- `APOLLO_API_KEY`, `GOOGLE_SHEET_ID` in `.env`
- Optional: `JOBHUNT_APOLLO_REVEAL_PERSONAL_EMAILS`, `JOBHUNT_STAGE4_MAX_URLS` (default 100)

### Tunables (env)

| Var | Default | Purpose |
|-----|---------|---------|
| `JOBHUNT_STAGE4_DUMP_DIR` | `data/stage4` | Per-run enrich dumps |
| `JOBHUNT_STAGE4_MAX_URLS` | `100` | Max URLs per enrich run |
| `JOBHUNT_SNAPSHOTS_DIR` | `data/snapshots` | Full-sheet snapshots (sync only) |

Enrich does **not** write to the sheet or `contacts-master-latest.json`.

## Google Sheets/Drive throughput

Every Sheets/Drive call in this project routes through
`integrations/google/rate-limit.mjs`, which provides:

1. A **per-lane token bucket** (`sheetsRead`, `sheetsWrite`, `drive`) that
   paces dispatch under Google's 60/min user quotas (Sheets) and the
   1M-quota-units/min Drive cap.
2. **Exponential backoff with jitter** on transient errors (`429`, `5xx`,
   and `403` responses with rate/quota wording in `errors[].reason` or the
   message body).
3. **Process counters** exposed via `getGoogleApiMetrics()`. Every stage
   report (`stage2`, `stage3`, `stage4`, `bootstrap`, `cleanup`,
   `ai-test/sync-report-to-command-center`) attaches:

   ```json
   "google_api_metrics": {
     "config":   { "qps": {...}, "burst": {...} },
     "counters": {
       "sheetsRead":  { "calls": 4,   "retries": 0, "last_status": 200 },
       "sheetsWrite": { "calls": 86,  "retries": 1, "last_status": 200 },
       "drive":       { "calls": 252, "retries": 0, "last_status": 200 }
     }
   }
   ```

   For Stage 3 it's also persisted in `data/stage3/<runId>/run-summary.json`.

### Tunables (all optional, defaults are safe)

| env | default | meaning |
| --- | ---: | --- |
| `JOBHUNT_GOOGLE_SHEETS_QPS` | `0.83` | tokens/sec for both `sheetsRead` and `sheetsWrite` lanes (≈ 50/min) |
| `JOBHUNT_GOOGLE_DRIVE_QPS` | `3.33` | tokens/sec for the `drive` lane (≈ 200/min) |
| `JOBHUNT_GOOGLE_SHEETS_BURST` | `10` | bucket capacity for Sheets lanes |
| `JOBHUNT_GOOGLE_DRIVE_BURST` | `30` | bucket capacity for Drive lane |
| `JOBHUNT_GOOGLE_RETRY_MAX_ATTEMPTS` | `5` | retries per call before giving up |
| `JOBHUNT_GOOGLE_RETRY_BASE_MS` | `1000` | first backoff delay |
| `JOBHUNT_GOOGLE_RETRY_MAX_MS` | `32000` | maximum backoff delay |

Raise QPS only after a real run shows `retries: 0` for the lane in
question. Lower QPS if you see retries climbing or `last_status: 429`.

### Stage 3 batching

Stage 3 batches Sheets writes per-job using `appendRows('CONTACTS_MASTER', ...)`
and `updateRanges([...], 'RAW')` so
each job costs at most 3 Sheets writes (instead of ~2 per contact). At
~80 contacts × 40 PURSUE jobs that's ~6,400 → ~120 sheets writes per run.

### Drive folder cache

`integrations/google/drive.mjs` keeps a process-scoped `Map` keyed on
`${parentId}|${name}` so repeated `ensureFolderPath(...)` calls (Stage 2
buckets, Stage 3 per-contact email folders) don't re-issue `files.list`
for the same company / job folders. The cache is process-local and
disappears when the run ends.

## Quick debugging checklist

If dropdown chips disappear in `SHORTLIST!B2:B` (often **B2** while B3+ still show arrows):

- Root cause is usually **appendRow(INSERT_ROWS) before** re-applying validation — fix is always to call `reapplyShortlistPursueDropdown()` after the last `SHORTLIST` append.
- Run `node jobhunt/inspect-shortlist-validation.mjs`
  - If `hasValidation=false` for B2.. rows, re-run `npm run jobhunt:bootstrap` and/or `npm run jobhunt:seed-8`
  - If `hasValidation=true` but UI doesn’t show chips, refresh the sheet; the rule exists.
