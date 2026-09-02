# Workflow 05: Audit and Retrospective

This workflow tracks codebase health, security posture, performance baselines, and engineering cadence.

## Available Skills
- `/health`: Code quality dashboard running linters, type checks, test suites, and dead code detectors (0-10 score).
- `/benchmark`: Measures page load performance, Core Web Vitals, and payload regressions.
- `/cso`: Chief Security Officer audit (secret archaeology, dependency supply chain, OWASP Top 10, STRIDE threat modeling).
- `/retro`: Weekly retrospective analyzing commit velocity, streak history, and team growth areas.

## How to Run in Antigravity
1. Run `/health` periodically to monitor technical debt and type safety.
2. Run `/cso` before major releases or after dependency changes.
3. Run `/retro` at the end of a milestone or sprint to review shipping velocity.
