# Command Center Data Dictionary

This file documents the Google Sheets “Command Center” tab schemas used by the JOBHUNT automation.

## `INBOX_RAW`
- **job_id**: Stable internal ID for this job across all tabs and Drive.
- **source**: Where the job was found (portal/job board/scanner source).
- **seen_at**: Timestamp when the pipeline first captured this job.
- **company**: Company name.
- **role**: Job title.
- **location**: Location as stated on the posting.
- **url**: Canonical job posting URL.
- **jd_drive_link**: Drive link to the stored job description snapshot (`JDS/...`) if already fetched.
- **match_score**: Stage-1 fit score on a **0-10** scale (stored as a string/number, populated by the Stage-1 qualifier).
- **status**: Current pipeline status for this raw row (e.g., `NEW`).
- **notes**: Freeform notes (dedup reason, exceptions, etc.).

## `SHORTLIST`
- **job_id**: Stable internal ID for this job across all tabs and Drive.
- **pursue**: Review decision dropdown (`UNREVIEWED`, `PURSUE`, `HOLD`, `SKIP`).
- **company**: Company name.
- **role**: Job title.
- **location**: Location as stated on the posting.
- **url**: Canonical job posting URL.
- **jd_drive_link**: Drive link to the stored job description snapshot (`JDS/...`).
- **match_score**: Stage-1 fit score on a **0-10** scale (used to prioritize review).
- **status**: Shortlist-stage status (e.g., `SHORTLISTED`).
- **priority**: Manual priority bucket (e.g., `P1`, `P2`, `P3`).
- **notes**: Freeform review notes.

## `CONTACTS`
Job-specific contacts for this role (may include multiple rows per job_id).
- **job_id**: Stable internal ID for this job across all tabs and Drive.
- **company**: Company name.
- **role**: Job title.
- **contact_name**: Person’s name.
- **contact_title**: Person’s title.
- **linkedin_url**: LinkedIn profile URL.
- **email**: Email address (if available).
- **email_source**: Where the email came from (manual, Apollo, Lusha, etc.).
- **email_confidence**: Confidence/verification status (freeform).
- **status**: Contact workflow status (pending/ready/contacted/etc.).
- **notes**: Freeform notes.

## `CONTACTS_MASTER`
Deduped “directory” of contacts across companies (reused before enrichment calls).
- **contact_id**: Canonical contact identifier (typically normalized email; or a generated ID if no email).
- **company**: Company name.
- **team**: Team/org (if known).
- **name**: Person’s name.
- **title**: Person’s title.
- **linkedin_url**: LinkedIn profile URL.
- **email**: Email address.
- **email_source**: Where the email came from.
- **email_confidence**: Confidence/verification status (freeform).
- **last_contacted_at**: Timestamp of last outreach attempt.
- **last_contacted_job_id**: job_id associated with last outreach attempt.
- **notes**: Freeform notes.

## `ASSETS`
Generated artifacts and links for a job.
- **job_id**: Stable internal ID for this job across all tabs and Drive.
- **company**: Company name.
- **role**: Job title.
- **status**: Assets workflow status (pending/ready/reviewed/etc.).
- **resume_drive_link**: Drive link to resume PDF (`RESUME/...`).
- **coverletter_drive_link**: Drive link to cover letter (`COVERLETTER/...`).
- **email_drive_link**: Drive link to outreach email draft doc (`EMAIL/...`).
- **jd_drive_link**: Drive link to JD snapshot (`JDS/...`).
- **context_drive_link**: Drive link to context pack (`CONTEXT/...`).
- **linkedin_invite_text**: Generated LinkedIn invite message (<=300 chars target).
- **linkedin_invite_char_count**: Character count for invite text.
- **updated_at**: Timestamp when assets were last generated/updated.
- **notes**: Freeform notes.

## `OUTREACH`
Outreach workflow tracking (draft-only now; later send + reply sync).
- **job_id**: Stable internal ID for this job across all tabs and Drive.
- **company**: Company name.
- **role**: Job title.
- **status**: Outreach workflow status (drafted/sent/responded/etc.).
- **channel**: Outreach channel (email/linkedin/etc.).
- **draft_subject**: Email subject line (if email channel).
- **draft_drive_link**: Drive link to the exact draft used for outreach (may diverge from `ASSETS.email_drive_link` over time).
- **zoho_draft_id**: Zoho draft ID (future).
- **sent_at**: Timestamp when sent (future).
- **followup_due**: Follow-up due date/timestamp.
- **notes**: Freeform notes.

## `PIPELINE_STATUS`
Canonical per-job lifecycle state.
- **job_id**: Stable internal ID for this job across all tabs and Drive.
- **company**: Company name.
- **role**: Job title.
- **canonical_status**: Current lifecycle status (e.g., `SHORTLISTED`, `APPLIED`, `RESPONDED`, etc.).
- **last_updated**: Timestamp of last status change.
- **next_action**: Suggested next action (review, generate assets, follow up, etc.).
- **notes**: Freeform notes.

