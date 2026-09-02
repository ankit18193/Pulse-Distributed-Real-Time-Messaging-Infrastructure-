---
description: Codebase quality dashboard: Runs linters, type checkers, test suites, and dead code detectors for composite 0-10 score.
---

# Code Health Audit Workflow

Run a comprehensive codebase quality audit and calculate composite 0-10 health score.

## Overview
Inspects code cleanliness, type safety, test coverage, and dead code accumulation.

## Protocol & Guidelines
1. Refer to the full skill specification at [SKILL.md](file:///.agents/skills/health/SKILL.md).
2. Execute linters, type checkers, and test runners via `run_command`.
3. Scan for dead code, unhandled promises, and deprecated APIs.
4. Compute weighted 0-10 code health score across:
   - Linting & formatting
   - Type coverage
   - Test pass rate & coverage
   - Dead code & dependency health
5. Generate health dashboard with actionable recommendations.
