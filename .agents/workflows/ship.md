---
description: Fully automated release & ship workflow: Verifies working tree, runs tests, reviews diff, bumps version, commits, and opens PR.
---

# Automated Release & Ship Workflow

Execute the full production shipping pipeline: test triage, diff review, version bump, commits, and PR.

## Overview
Ensures nothing broken ships to production. Automates release checklist from tests to pull request.

## Protocol & Guidelines
1. Refer to the full skill specification at [SKILL.md](file:///.agents/skills/ship/SKILL.md).
2. Verify working tree status: zero uncommitted unintended files.
3. Run automated test suites via `run_command`. All tests must pass.
4. Perform pre-landing sanity review on full branch diff.
5. Bump version and generate release changelog.
6. Create atomic, bisectable git commits with clear conventional messages.
7. Push branch and prepare pull request details.
