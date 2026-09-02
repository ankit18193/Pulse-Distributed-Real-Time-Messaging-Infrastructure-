---
description: Fast browser automation & inspection: Navigates URLs, verifies DOM elements, inspects layouts, and captures screenshots.
---

# Browser Inspection Workflow

Automate browser navigation, inspect DOM structure, and verify UI state.

## Overview
Quickly inspects web pages, captures screenshots, and checks rendered markup.

## Protocol & Guidelines
1. Refer to the full skill specification at [SKILL.md](file:///.agents/skills/browse/SKILL.md).
2. Use Antigravity native `browser_subagent` for interactive tasks and recordings.
3. Use `read_url_content` for fast text/markdown DOM extraction.
4. Verify element states, console logs, and visual responsiveness.
5. Return concise summary of findings to user.
