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
3. Optional: `npm run jobhunt:ai-verify-models` — confirms all four **`ANTHROPIC_MODEL_{SCORE,LINKEDIN,RESUME,OUTREACH}`** ids work (or defaults).
4. Run: **`npm run jobhunt:ai-score-urls`** — writes **`jobhunt/ai-test/output/last-report.json`** (gitignored).

Some employers block headless fetch or require login; **`page_quality`** in the report hints at bad extractions. Prefer public ATS job links when you can.

After changing **`config/profile.yml`** (e.g. SWE scoring rules), re-run **`npm run jobhunt:ai-score-urls`** so **`last-report.json`** reflects the new instructions, then:

**Push scores + JD files into Command Center + Drive**

1. `npm run jobhunt:ai-sync-sheets` — reads **`jobhunt/ai-test/output/last-report.json`**, skips URLs already in **`INBOX_RAW`**, uploads **JDS** + **CONTEXT**, appends **INBOX_RAW**, promotes to **SHORTLIST** when **score ≥ 6.0**, reapplies **pursue** dropdown.
2. In the sheet, set **`SHORTLIST.pursue`** as needed.
3. `npm run jobhunt:stage2` — requires **`ANTHROPIC_API_KEY`**; downloads each **JD** from Drive, then Claude generates **`.tex` resume**, formatted **cover letter**, and **outreach email** (subject + body with salutation/closing) + **LinkedIn invite** snippet. Compile **`.tex`** locally (see `templates/cv-template.tex`). Review all copy before sending.

## Stage 3 — Apollo recruiter / hiring-manager outreach drafts

`npm run jobhunt:stage3` runs **after** Stage 2 has generated `ASSETS` for the
PURSUE jobs you care about. It enriches `CONTACTS` and `CONTACTS_MASTER` and
saves per-contact email + LinkedIn invite drafts to Drive — **never sends**.

### Prerequisites

- **`APOLLO_API_KEY`** in `.env` (see `.env.example`).
- **`ANTHROPIC_API_KEY`** in `.env` (used by per-contact generators).
- A recent **`npm run jobhunt:stage2`** run so `ASSETS.resume_summary` and `ASSETS.jd_drive_link` exist for each PURSUE row.
- Sheet headers updated: `CONTACTS` now has 15 columns (adds `contact_id`, `contact_kind`, `email_drive_link`, `linkedin_invite_text`). Run **`npm run jobhunt:bootstrap`** once after pulling these changes — it overwrites only row 1; data rows below are preserved.

### What it does

1. Read **`SHORTLIST`**, take rows where **`pursue == 'PURSUE'`** that also have an **`ASSETS`** row.
2. For each: Apollo `mixed_companies/search` (org lookup) → `mixed_people/search` for **recruiters** (title filter) and **hiring managers** (seniority + role-derived title/department filter).
3. Pagination ceiling per kind defaults to **`JOBHUNT_STAGE3_PER_KIND_MAX=10`**, **doubled** when Apollo reports `estimated_num_employees >= JOBHUNT_STAGE3_BIGCO_EMPLOYEE_THRESHOLD` (default `5000`). Soft floor `JOBHUNT_STAGE3_PER_KIND_MIN=2` is logged-only — small startups gracefully degrade.
4. Dedup against **`CONTACTS_MASTER`** by `linkedin_url`, then `email`. Reuse the existing `contact_id` or mint a new `CT-<YYYYMMDD>-<8-hex>`.
5. If a candidate has no email but does have a LinkedIn URL, call Apollo `/people/match` to reveal one. **This step consumes Apollo email-reveal credits.**
6. Generate per-contact email + LinkedIn invite via Claude (`generatePersonalizedRecruiterEmail`, `generatePersonalizedLinkedInInvite`). Email goes to Drive `EMAIL/<company>/<job>/email-<job_id>-<contact_id>.txt`; invite text goes inline into `CONTACTS.linkedin_invite_text`.
7. Append a **`CONTACTS`** row per (job, contact). Append a **`CONTACTS_MASTER`** row for new contacts, or update `last_contacted_at` / `last_contacted_job_id` on the existing one.

### Tunables (env)

| Var | Default | Purpose |
|-----|---------|---------|
| `JOBHUNT_STAGE3_PER_KIND_MIN` | `2` | Soft floor; warns if Apollo returns fewer for a kind |
| `JOBHUNT_STAGE3_PER_KIND_MAX` | `10` | Hard ceiling per kind (doubled at big-co threshold) |
| `JOBHUNT_STAGE3_BIGCO_EMPLOYEE_THRESHOLD` | `5000` | Doubles ceiling for FAANG-scale orgs |
| `JOBHUNT_STAGE3_LIMIT` | unset | Cap PURSUE rows processed per run; useful for dry-runs (e.g. `1`) |
| `JOBHUNT_REGENERATE_CONTACTS` | unset | When `1`, re-runs even for jobs that already have CONTACTS rows |

### Recommended dry-run on a fresh setup

```bash
JOBHUNT_STAGE3_LIMIT=1 npm run jobhunt:stage3
```

Inspect: the first PURSUE company should produce a few rows in `CONTACTS`,
matching new rows in `CONTACTS_MASTER`, and per-contact `.txt` files under
`EMAIL/<company>/<job>/`. Re-running stage 3 (without the env vars) on the
same job should be a no-op (`skipped_already_has_contacts++`). Re-running with
`JOBHUNT_REGENERATE_CONTACTS=1` regenerates drafts and updates
`CONTACTS_MASTER.last_contacted_*` instead of appending duplicates.

### Apollo cost note

- **Free plan: API access is BLOCKED.** Both `/v1/mixed_companies/search` and
  `/v1/mixed_people/search` return 403 with "is not accessible with this
  api_key on a free plan" on Apollo's free tier — verified empirically. Stage 3
  handles `/mixed_companies/search` blockage gracefully (falls back to a
  guessed primary domain), but if `/mixed_people/search` is also blocked the
  job lands in `report.errors` with the Apollo message and the run continues
  to the next job. Upgrade to at least the Basic plan (currently around $49/mo)
  for API access.
- **Paid plans:** search calls are cheap; `/v1/people/match` (the email reveal
  step) is **credit-metered**. If you scan all of `portals.yml` and PURSUE
  many companies in a month, you may exceed your monthly pool. There is no
  automatic gate; the script will keep requesting reveals until Apollo
  returns 429 / out-of-credits errors (those are caught per-contact and
  surfaced in `report.jobs[].warnings`).

### Inspecting failures

The script prints a single JSON `report` object on stdout with:

- `processed`, `skipped_no_assets`, `skipped_already_has_contacts`
- `contacts_created` vs `contacts_reused`
- `jobs[].warnings` — per-job non-fatal issues (Apollo enrich failed, kind below floor, …)
- `errors` — per-job hard failures (continues to next job)

`cleanup-test-data.mjs` already clears both `CONTACTS` and `CONTACTS_MASTER`,
so the canonical end-to-end test still resets cleanly.

## Quick debugging checklist

If dropdown chips disappear in `SHORTLIST!B2:B` (often **B2** while B3+ still show arrows):

- Root cause is usually **appendRow(INSERT_ROWS) before** re-applying validation — fix is always to call `reapplyShortlistPursueDropdown()` after the last `SHORTLIST` append.
- Run `node jobhunt/inspect-shortlist-validation.mjs`
  - If `hasValidation=false` for B2.. rows, re-run `npm run jobhunt:bootstrap` and/or `npm run jobhunt:seed-8`
  - If `hasValidation=true` but UI doesn’t show chips, refresh the sheet; the rule exists.
