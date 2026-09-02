---
description: Full safety shield: Activates both careful (destructive command warning) and freeze (directory edit lock) simultaneously.
---

# Full Safety Shield (Guard) Workflow

Activate maximum safety protections: destructive command guard and directory edit lock.

## Overview
Combines `/careful` and `/freeze` for high-risk operations and tightly scoped edits.

## Protocol & Guidelines
1. Refer to the full skill specification at [SKILL.md](file:///.agents/skills/guard/SKILL.md).
2. Enforce confirmation before any destructive shell commands.
3. Enforce directory boundary limits on all file edits.
4. Maintain strict safety until explicitly released via `/unfreeze`.
