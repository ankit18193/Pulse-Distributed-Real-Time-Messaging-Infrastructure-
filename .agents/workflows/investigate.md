---
description: Systematic root-cause debugging: 4-phase protocol (Reproduction → Instrumentation → Root Cause → Fix & Verification).
---

# Systematic Root-Cause Investigation Workflow

Execute the 4-phase scientific debugging protocol to identify and eliminate root causes.

## Overview
Never writes speculative fixes. Follows evidence-driven diagnosis from reproduction to verification.

## Protocol & Guidelines
1. Refer to the full skill specification at [SKILL.md](file:///.agents/skills/investigate/SKILL.md).
2. Follow the 4 phases:
   - **Phase 1 (Reproduction)**: Create minimal reproduction script or test case. Capture exact failure output.
   - **Phase 2 (Instrumentation)**: Add tracing, inspect state, and verify assumptions with evidence.
   - **Phase 3 (Root Cause)**: Pinpoint exact file, function, line, and mechanism of failure.
   - **Phase 4 (Fix & Verification)**: Implement targeted fix, verify reproduction passes, and check for regressions.
3. Clean up all temporary diagnostic instrumentation before finishing.
