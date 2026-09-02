---
description: Composite auto-review pipeline: Runs CEO → Design → DevEx → Eng review sequentially with single approval gate.
---

# Automated Review Pipeline (AutoPlan) Workflow

Run the full sequential review gauntlet: CEO → Design → DevEx → Eng review.

## Overview
Chains all 4 plan-mode reviews into a unified pipeline with an aggregated decision brief and single approval gate.

## Protocol & Guidelines
1. Refer to the full skill specification at [SKILL.md](file:///.agents/skills/autoplan/SKILL.md).
2. Sequentially execute:
   - **Phase 1 (CEO)**: Scope and 10-star product ambition.
   - **Phase 2 (Design)**: Visual hierarchy and interaction states.
   - **Phase 3 (DevEx)**: TTHW and friction removal.
   - **Phase 4 (Eng)**: Architecture, failure blast radius, and test matrix.
3. Aggregate all findings into a unified decision brief using `ask_question`.
4. Update `implementation_plan.md` with final locked requirements upon approval.
