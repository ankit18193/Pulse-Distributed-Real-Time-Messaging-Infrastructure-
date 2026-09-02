---
description: Eng manager-mode plan review: Lock in execution plan, architecture, data flow, ASCII diagrams, edge cases, and tests.
---

# Engineering Plan Review Workflow

Execute rigorous engineering manager review to lock in architecture and execution details before implementation.

## Overview
Stress-tests architecture, data flows, edge cases, failure blast radius, and test coverage matrices.

## Protocol & Guidelines
1. Refer to the full skill specification at [SKILL.md](file:///.agents/skills/plan-eng-review/SKILL.md).
2. Inspect and refine the `implementation_plan.md` artifact.
3. Validate against:
   - **The Reuse Ladder**: Repository utils → Stdlib → Platform feature → Installed deps → Custom code.
   - **Data Flow & ASCII Diagrams**: Document components, interfaces, and state transitions.
   - **Failure Modes & Blast Radius**: Network drops, partial writes, disconnects, resource exhaustion.
   - **Test Matrix**: Automated unit, integration, and failure path test definitions.
4. Surface architectural decisions via `ask_question` and obtain explicit engineering sign-off.
