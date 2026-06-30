# Templates

System-layer template files used by career-ops scripts and modes.

## Files

| File | Used By | Purpose |
|------|---------|---------|
| `cv-template.tex` | `generate-latex.mjs`, `jobhunt/stage2` | LaTeX/Overleaf template for ATS-optimized CV PDFs |
| `portals.example.yml` | Onboarding | Example portal scanner configuration (copy to `config/portals.yml` to activate) |
| `outreach/**` | `jobhunt/stage3` | Email and LinkedIn outreach templates by role family |

### cv-template.tex

LaTeX template for Overleaf-compatible CV generation. Based on the [sb2nov/resume](https://github.com/sb2nov/resume) format. Uses placeholder tokens (`{{NAME}}`, `{{EXPERIENCE}}`, `{{PROJECTS}}`, etc.) that the LaTeX pipeline fills at generation time.

**Design:** Single-column ATS-safe layout using standard CTAN packages (`fontawesome5`, `enumitem`, `hyperref`, `titlesec`). No custom fonts or external dependencies — uploads directly to Overleaf.

**Usage:**
```bash
# Validate and compile .tex → .pdf (requires pdflatex on PATH)
node generate-latex.mjs output/cv-name-company-date.tex

# Or specify a custom output path
node generate-latex.mjs output/cv-name-company-date.tex output/custom-name.pdf
```

**Prerequisites:** `pdflatex` via [MiKTeX](https://miktex.org/) (Windows) or TeX Live (Linux/macOS). First compilation may auto-install missing LaTeX packages. Alternatively, upload the `.tex` file directly to [Overleaf](https://www.overleaf.com) — no local install needed.

**Customization:** Edit this file to change margins, section order, or formatting commands. The placeholder tokens are documented in `modes/latex.md` under "Template Placeholders."

### portals.example.yml

Pre-configured portal scanner with tracked companies and search queries. Contains title filters, company career page URLs, Greenhouse API endpoints, and WebSearch queries.

**To activate:** Copy to `config/portals.yml` and customize `title_filter.positive` keywords for your target roles. Add or remove companies as needed.

### outreach/

Disk templates for Stage 3 outreach drafts (`templates/outreach/emails/` and `templates/outreach/linkedin/`). See `templates/outreach/README.md`.
