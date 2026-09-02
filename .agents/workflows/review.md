---
description: Pre-landing code and PR review: Systematic multi-perspective audit (concurrency, security, performance, edge cases).
---

# Pre-Landing Code Review Workflow

Execute systematic multi-perspective code audit on pending changes before merging.

## Overview
Catches subtle bugs that pass CI but cause production outages (race conditions, resource leaks, edge cases).

## Protocol & Guidelines
1. Refer to the full skill specification at [SKILL.md](file:///.agents/skills/review/SKILL.md).
2. Audit working tree diffs using [checklist.md](file:///.agents/skills/review/checklist.md) and specialist rubrics in [.agents/skills/review/specialists/](file:///.agents/skills/review/specialists/).
3. Audit against:
   - **Concurrency & State**: Race conditions, mutex contention, unclosed channels/sockets.
   - **Resource Management**: Memory leaks, connection leaks, unhandled error paths.
   - **Security**: Injection risks, auth bypass, credential exposure.
4. Triage findings using [greptile-triage.md](file:///.agents/skills/review/greptile-triage.md) and record debt in [TODOS-format.md](file:///.agents/skills/review/TODOS-format.md).
5. Produce a clear Go / No-Go review summary.
