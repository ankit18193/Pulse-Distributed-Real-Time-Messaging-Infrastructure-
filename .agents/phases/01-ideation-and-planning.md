# Workflow 01: Ideation and Planning

This workflow governs project ideation, premise testing, scope definition, and architectural planning before writing code.

## Available Skills
- `/office-hours`: YC office-hours brainstorming. 6 forcing questions on demand reality, desperate specificity, and narrowest wedge.
- `/plan-ceo-review`: CEO/founder-mode plan review. Finds the 10-star product; scope expansion or ruthless simplification.
- `/plan-eng-review`: Eng manager-mode architecture review. Validates data flow, failure modes, ASCII diagrams, test matrices.
- `/plan-design-review`: Designer's-eye review across 10 design dimensions.
- `/plan-devex-review`: DevEx review focusing on Time-to-Hello-World (TTHW) and friction points.
- `/autoplan`: Runs CEO → Design → DevEx → Eng review sequentially.

## How to Run in Antigravity
1. **Brainstorming**: Start with `/office-hours` to validate the problem statement and establish a design doc.
2. **Reviewing an Implementation Plan**: When drafting an architectural plan (e.g. `implementation_plan.md`), run `/plan-eng-review` to lock in component boundaries, interfaces, and testing strategies.
3. **Automatic Gauntlet**: Use `/autoplan` to review a major architecture proposal across all dimensions with a single approval gate.
