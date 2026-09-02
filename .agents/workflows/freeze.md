---
description: Directory edit restrictor: Locks file modifications strictly to an allowed directory path to prevent scope creep.
---

# Directory Edit Lock Workflow

Lock modifications strictly to a specific subsystem directory.

## Overview
Prevents scope creep during focused implementation by restricting file edits to an allowed path.

## Protocol & Guidelines
1. Refer to the full skill specification at [SKILL.md](file:///.agents/skills/freeze/SKILL.md).
2. Set allowed path boundary.
3. Block any tool operations that attempt to create or modify files outside the locked directory.
4. Report scope violations immediately.
5. Use `/unfreeze` to remove boundary locks when complete.
