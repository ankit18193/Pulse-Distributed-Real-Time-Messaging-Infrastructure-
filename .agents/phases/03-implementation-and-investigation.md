# Workflow 03: Implementation and Investigation

This workflow governs hands-on code development, safety scoping, and root-cause debugging.

## Available Skills
- `/investigate`: 4-phase systematic debugging:
  1. Reproduction & Evidence
  2. Instrumentation & Tracing
  3. Root Cause Identification
  4. Fix & Regression Verification
- `/careful`: Destructive command guardrails (warns before force-push, drop table, rm -rf).
- `/freeze`: Restricts file modifications to a single directory to prevent scope creep.
- `/guard`: Activates both careful and freeze simultaneously.
- `/unfreeze`: Clears directory edit locks.

## How to Run in Antigravity
1. **When debugging unexpected errors or failures**: Invoke `/investigate`. Never guess or patch symptoms without finding the root cause.
2. **When running sensitive terminal commands**: Use `/careful` or `/guard` to prevent unintentional data loss or scope creep.
