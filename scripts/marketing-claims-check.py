#!/usr/bin/env python3
"""Fail closed when retired marketing fixtures or unsupported claims return.

This is a source-boundary gate, not a legal or clinical review. It protects the
specific failure mode found before release: old route catalogues made fictional
providers, certifications, customer results, release history and specialist
workflows look like shipped product features.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

RETIRED_PATHS = [
    "PLAN.md",
    "lib/blog.ts",
    "lib/careers.ts",
    "lib/compare.ts",
    "lib/compare",
    "lib/customer-stories.ts",
    "lib/deep-dives.ts",
    "lib/deep-dives",
    "lib/docs.ts",
    "lib/docs-content",
    "lib/glossary.ts",
    "lib/integrations.ts",
    "lib/integrations",
    "lib/legal.ts",
    "lib/playground-data.ts",
    "lib/posts",
    "lib/providers.ts",
    "lib/releases.ts",
    "lib/sitemap-data.ts",
    "lib/status.ts",
    "lib/stories",
    "lib/templates.ts",
    "lib/templates",
    "lib/trust.ts",
    "components/docs",
    "components/site/BlogChrome.tsx",
    "components/site/BlogIndex.tsx",
    "components/site/CliView.tsx",
    "components/site/CustomersDirectory.tsx",
    "components/site/DeepDiveBlocks.tsx",
    "components/site/GlossaryIndex.tsx",
    "components/site/IntegrationsDirectory.tsx",
    "components/site/LibraryView.tsx",
    "components/site/PlatformTabs.tsx",
    "components/site/PricingTable.tsx",
    "components/site/TemplatesGallery.tsx",
]

# Routes retained for old links must not render the removed catalogues.
REDIRECT_PAGES = [
    "app/(site)/ai-voice-agents/page.tsx",
    "app/(site)/blog/page.tsx",
    "app/(site)/blog/[slug]/page.tsx",
    "app/(site)/blog/author/[slug]/page.tsx",
    "app/(site)/blog/authors/page.tsx",
    "app/(site)/blog/category/[slug]/page.tsx",
    "app/(site)/blog/page/[page]/page.tsx",
    "app/(site)/blog/tag/[slug]/page.tsx",
    "app/(site)/careers/[slug]/page.tsx",
    "app/(site)/changelog/page.tsx",
    "app/(site)/changelog/[release]/page.tsx",
    "app/(site)/cli/page.tsx",
    "app/(site)/compare/page.tsx",
    "app/(site)/compare/[slug]/page.tsx",
    "app/(site)/creators/page.tsx",
    "app/(site)/custom-agents/page.tsx",
    "app/(site)/customers/[slug]/page.tsx",
    "app/(site)/enhanced-security/page.tsx",
    "app/(site)/glossary/page.tsx",
    "app/(site)/glossary/[term]/page.tsx",
    "app/(site)/gpt-live-waitlist/page.tsx",
    "app/(site)/hackathon/page.tsx",
    "app/(site)/industries/page.tsx",
    "app/(site)/industries/[slug]/page.tsx",
    "app/(site)/integrations/page.tsx",
    "app/(site)/integrations/[slug]/page.tsx",
    "app/(site)/legal/[slug]/page.tsx",
    "app/(site)/library/page.tsx",
    "app/(site)/partnerships/page.tsx",
    "app/(site)/playbook/page.tsx",
    "app/(site)/sales/page.tsx",
    "app/(site)/single-prompt/page.tsx",
    "app/(site)/solutions/[slug]/page.tsx",
    "app/(site)/startups/page.tsx",
    "app/(site)/templates/page.tsx",
    "app/(site)/templates/[slug]/page.tsx",
    "app/(site)/trust/page.tsx",
    "app/(site)/trust/questionnaire/page.tsx",
    "app/(site)/twist/page.tsx",
    "app/(site)/vapicon/page.tsx",
    "app/(site)/vapicon/speakers/page.tsx",
    "app/(site)/vapicon-2026-speaker-submissions/page.tsx",
    "app/docs/[...slug]/page.tsx",
]

SAFE_REDIRECT_TARGETS = {
    "/",
    "/platform",
    "/pricing",
    "/solutions",
    "/docs",
    "/security",
    "/contact",
    "/customers",
    "/careers",
    "/legal",
    "/dashboard/assistants/new",
}

PUBLIC_SOURCE_ROOTS = [
    ROOT / "app/(site)",
    ROOT / "app/(auth)",
    ROOT / "app/docs",
    ROOT / "app/dashboard",
    ROOT / "components/site",
    ROOT / "components/dash",
]
PUBLIC_SOURCE_FILES = [
    ROOT / "app/layout.tsx",
    ROOT / "app/not-found.tsx",
    ROOT / "app/sitemap.ts",
    ROOT / "lib/content.ts",
    ROOT / "lib/search-index.ts",
]
CURRENT_HANDOFF_DOCS = [
    ROOT / "README.md",
    ROOT / "CAPABILITIES.md",
    ROOT / "MULTI-BUSINESS-PLAN.md",
    ROOT / "PILOT-DEPLOYMENT.md",
    ROOT / "PRODUCTION-PLAN-DOKPLOY.md",
    ROOT / "PRODUCTION-READINESS-EVIDENCE.md",
]

# These vendors are not implemented integrations. Naming one is allowed only in
# an explicit boundary such as “Notion ingestion is not available”.
UNSUPPORTED_VENDOR = re.compile(
    r"\b(?:Salesforce|HubSpot|Zendesk|Shopify|Telnyx|Vonage|SendGrid|Mailgun|Epic(?:\s+FHIR)?|"
    r"Intercom|Zapier|Airtable|Five9|Genesys|Avaya|AssemblyAI|Gladia|Soniox|Speechmatics|PlayHT|Rime)\b",
    re.IGNORECASE,
)
BOUNDARY = re.compile(
    r"\b(?:no|not|never|without|unavailable|unsupported|not implemented|does not|do not|retired|requires? external|verify separately)\b",
    re.IGNORECASE,
)

FORBIDDEN_PATTERNS = [
    ("certification claim", re.compile(r"\b(?:HIPAA|GDPR|PCI(?:\s+DSS)?|SOC\s*2|ISO\s*27001)[ -]?(?:compliant|certified)\b", re.IGNORECASE)),
    ("fabricated reliability figure", re.compile(r"\b99\.(?:9|95|99|999)%\b", re.IGNORECASE)),
    ("fabricated scale figure", re.compile(r"\b\d+(?:\.\d+)?\s*(?:million|billion)\s+(?:calls?|minutes?|customers?|assistants?)\b", re.IGNORECASE)),
    ("unverified endorsement", re.compile(r"\b(?:trusted by|customers? (?:choose|love|trust|rely on)|case study:)\b", re.IGNORECASE)),
    ("unverified outcome", re.compile(r"\b\d+(?:\.\d+)?%\s+(?:increase|decrease|improvement|reduction|saved|faster|more)\b", re.IGNORECASE)),
    ("clinical suitability claim", re.compile(r"\b(?:clinically validated|clinical-grade|suitable for clinical use|diagnoses patients?|recommends? treatment)\b", re.IGNORECASE)),
]

CERTIFICATION_TERM = re.compile(r"\b(?:HIPAA|GDPR|PCI(?:\s+DSS)?|SOC\s*2|ISO\s*27001|BAA)\b", re.IGNORECASE)
LEGACY_PUBLIC_HREF = re.compile(
    r"['\"]/(?:integrations|templates|compare|blog|glossary|changelog|industries)(?:/[^'\"]*)?['\"]"
)

checks = 0
errors: list[str] = []


def passed(message: str) -> None:
    global checks
    checks += 1
    print(f"PASS {message}")


def failed(message: str) -> None:
    errors.append(message)
    print(f"FAIL {message}")


for relative in RETIRED_PATHS:
    path = ROOT / relative
    if path.exists():
        failed(f"retired claim source still exists: {relative}")
    else:
        passed(f"retired source absent: {relative}")

redirect_re = re.compile(r"\bredirect\(\s*['\"]([^'\"]+)['\"]\s*\)")
for relative in REDIRECT_PAGES:
    path = ROOT / relative
    if not path.is_file():
        failed(f"legacy route boundary missing: {relative}")
        continue
    match = redirect_re.search(path.read_text(encoding="utf-8"))
    if not match:
        failed(f"legacy route renders content instead of redirecting: {relative}")
    elif match.group(1) not in SAFE_REDIRECT_TARGETS:
        failed(f"legacy route has an unapproved redirect target {match.group(1)!r}: {relative}")
    else:
        passed(f"legacy route redirects safely: {relative} -> {match.group(1)}")

public_files: set[Path] = set()
for root in PUBLIC_SOURCE_ROOTS:
    if root.exists():
        public_files.update(p for p in root.rglob("*") if p.is_file() and p.suffix in {".ts", ".tsx"})
public_files.update(path for path in PUBLIC_SOURCE_FILES if path.is_file())
public_files.update(path for path in CURRENT_HANDOFF_DOCS if path.is_file())
deploy_docs = ROOT / "deploy"
if deploy_docs.exists():
    public_files.update(path for path in deploy_docs.rglob("*.md") if path.is_file())

for path in sorted(public_files):
    relative = path.relative_to(ROOT)
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    for line_number, line in enumerate(lines, 1):
        # Markdown and JSX often wrap one sentence over several source lines.
        # A narrow context window recognizes an adjacent “does not” without
        # letting a file-wide disclaimer excuse unrelated affirmative copy.
        context = " ".join(lines[max(0, line_number - 6) : min(len(lines), line_number + 1)])
        vendor = UNSUPPORTED_VENDOR.search(line)
        if vendor and not BOUNDARY.search(context):
            failed(f"unsupported vendor {vendor.group(0)!r} lacks an explicit boundary at {relative}:{line_number}")
        for label, pattern in FORBIDDEN_PATTERNS:
            if pattern.search(line) and not BOUNDARY.search(context):
                failed(f"{label} at {relative}:{line_number}: {line.strip()[:180]}")
        if CERTIFICATION_TERM.search(line) and not BOUNDARY.search(context):
            failed(f"certification/healthcare term lacks a denial or external-review boundary at {relative}:{line_number}")

passed(f"scanned {len(public_files)} user-visible source files for affirmative unsupported claims")

search_index = (ROOT / "lib/search-index.ts").read_text(encoding="utf-8")
legacy_hrefs = sorted(set(LEGACY_PUBLIC_HREF.findall(search_index)))
if legacy_hrefs:
    failed(f"search index republishes retired routes: {', '.join(legacy_hrefs)}")
else:
    passed("search index contains no retired catalogue routes")

sitemap = (ROOT / "app/sitemap.ts").read_text(encoding="utf-8")
legacy_sitemap = sorted(set(LEGACY_PUBLIC_HREF.findall(sitemap)))
if legacy_sitemap:
    failed(f"sitemap republishes retired routes: {', '.join(legacy_sitemap)}")
else:
    passed("sitemap contains no retired catalogue routes")

if errors:
    print(f"\n{checks} checks passed / {len(errors)} failed")
    return_code = 1
else:
    print(f"\n{checks} checks passed / 0 failed")
    return_code = 0

sys.exit(return_code)
