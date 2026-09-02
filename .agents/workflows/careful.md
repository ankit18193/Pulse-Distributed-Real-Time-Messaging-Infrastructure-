---
description: Destructive command guardrails: Enforces warning and confirmation before executing high-risk operations.
---

# Destructive Command Guardrail Workflow

Activate safety guardrails against dangerous terminal commands.

## Overview
Protects repository against accidental deletion, forced resets, data drops, and destructive overrides.

## Protocol & Guidelines
1. Refer to the full skill specification at [SKILL.md](file:///.agents/skills/careful/SKILL.md).
2. Intercept and require explicit user confirmation before:
   - `rm -rf`, `Remove-Item -Recurse`
   - `git reset --hard`, `git clean -fd`
   - `git push --force`
   - Database drops or destructive migrations
3. Ensure safe fallbacks (dry-runs, backups) are evaluated first.
