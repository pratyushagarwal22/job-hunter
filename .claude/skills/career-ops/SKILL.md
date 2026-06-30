---
name: career-ops
description: AI job search command center -- JOBHUNT pipeline, CV generation, portal scanning
user_invocable: true
args: mode
argument-hint: "[scan | deep | latex | ofertas | apply | pipeline | training | project | interview-prep]"
---

# career-ops -- Router

## Primary workflow

The canonical pipeline is the **JOBHUNT Command Center** (Google Sheets + Drive). See `jobhunt/RUNBOOK.md` and run npm scripts:

```
npm run jobhunt:cleanup
npm run jobhunt:bootstrap
npm run jobhunt:ai-score-urls
npm run jobhunt:ai-sync-sheets
npm run jobhunt:stage2
npm run jobhunt:stage3
npm run jobhunt:stage4-enrich
npm run jobhunt:stage4-sync
```

## Mode Routing

Determine the mode from `{{mode}}`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| JD text or URL (no sub-command) | **`auto-pipeline`** |
| `ofertas` | `ofertas` |
| `deep` | `deep` |
| `latex` | `latex` |
| `training` | `training` |
| `project` | `project` |
| `pipeline` | `pipeline` |
| `apply` | `apply` |
| `scan` | `scan` |
| `interview-prep` | `interview-prep` |

**Auto-pipeline detection:** If `{{mode}}` is not a known sub-command AND contains JD text (keywords: "responsibilities", "requirements", "qualifications", "about the role", "we're looking for", company name + role) or a URL to a JD, execute `auto-pipeline`.

If `{{mode}}` is not a sub-command AND doesn't look like a JD, show discovery.

---

## Discovery Mode (no arguments)

Show this menu:

```
career-ops -- Command Center

JOBHUNT pipeline (primary):
  npm run jobhunt:cleanup → bootstrap → ai-score-urls → ai-sync-sheets → stage2 → stage3 → stage4-*

Cursor modes:
  /career-ops {JD}           → AUTO-PIPELINE: evaluate + LaTeX CV (paste text or URL)
  /career-ops pipeline       → Process pending URLs
  /career-ops ofertas        → Compare and rank multiple offers
  /career-ops deep           → Deep research prompt about company
  /career-ops latex          → LaTeX/Overleaf CV export (generate-latex.mjs)
  /career-ops training       → Evaluate course/cert against North Star
  /career-ops project        → Evaluate portfolio project idea
  /career-ops apply          → Live application assistant (reads form + generates answers)
  /career-ops scan           → Scan portals and discover new offers (config/portals.yml)
  /career-ops interview-prep → Interview prep for a specific company/role

Full runbook: jobhunt/RUNBOOK.md
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `ofertas`, `latex`, `apply`, `pipeline`, `scan`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `deep`, `training`, `project`, `interview-prep`

### Modes delegated to subagent:
For `scan`, `apply` (with Playwright), and `pipeline` (3+ URLs): launch as Agent with the content of `_shared.md` + `modes/{mode}.md` injected into the subagent prompt.

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of modes/_shared.md]\n\n[content of modes/{mode}.md]\n\n[invocation-specific data]",
  description="career-ops {mode}"
)
```

Execute the instructions from the loaded mode file.
