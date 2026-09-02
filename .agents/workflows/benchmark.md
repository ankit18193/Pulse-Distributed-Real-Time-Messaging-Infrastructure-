---
description: Performance regression and load detection: Measures page load times, Core Web Vitals, and payload sizes.
---

# Performance Benchmark Workflow

Measure application latency, load times, Core Web Vitals, and detect performance regressions.

## Overview
Audits runtime performance, network payload sizes, and connection throughput.

## Protocol & Guidelines
1. Refer to the full skill specification at [SKILL.md](file:///.agents/skills/benchmark/SKILL.md).
2. Benchmark target flows using automated scripts or browser instrumentation.
3. Measure: Time-to-First-Byte (TTFB), DOM load, connection establishment latency, payload weight.
4. Compare against baseline thresholds and flag regressions.
5. Provide specific optimization targets (caching, payload compression, query optimization).
