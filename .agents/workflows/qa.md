---
description: Autonomous QA testing & bug fixing: Drives a browser, crawls flows, identifies bugs, creates atomic commits, and verifies.
---

# Autonomous QA Testing & Bug Fixing Workflow

Execute autonomous browser-driven QA exploration, bug identification, and atomic fixes.

## Overview
Acts as an autonomous QA engineer: drives browser, explores flows, discovers functional and visual defects, and fixes them.

## Protocol & Guidelines
1. Refer to the full skill specification at [SKILL.md](file:///.agents/skills/qa/SKILL.md).
2. Reference [issue-taxonomy.md](file:///.agents/skills/qa/references/issue-taxonomy.md) and [qa-report-template.md](file:///.agents/skills/qa/templates/qa-report-template.md).
3. Drive user journeys using `browser_subagent` to trigger edge cases, form validations, and error states.
4. For discovered bugs:
   - Document reproduction steps and capture screenshot/video evidence.
   - Implement targeted fix in codebase.
   - Re-test in browser to confirm fix.
   - Create clean, bisectable commit.
5. Generate comprehensive final QA report.
