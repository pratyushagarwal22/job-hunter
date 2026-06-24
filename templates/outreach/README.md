# Outreach Templates (placeholder-first)

Folder layout:

- `templates/outreach/emails/<ROLE_ARCHETYPE>/<RECIPIENT_KIND>.txt`
- `templates/outreach/linkedin/<ROLE_ARCHETYPE>/<RECIPIENT_KIND>.txt`

Supported role archetypes:
- `ANALYST`, `DE`, `BI`, `PRODUCT`, `SWE`

Supported recipient kinds:
- `RECRUITER`, `HIRING_MANAGER`

Placeholder tokens (rendered by `career-ops/jobhunt/lib/outreach-template.mjs`):
- `[Name]`
- `[Company]`
- `[RoleType]`

Email template format:
- First line: `Subject: ...`
- Blank line
- Body text

