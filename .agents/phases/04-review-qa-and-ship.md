# Workflow 04: Review, QA, and Ship

This workflow ensures code is robust, thoroughly tested, peer-reviewed, and safely released.

## Available Skills
- `/review`: Pre-landing PR review covering security, performance, data migrations, edge cases, and maintainability.
- `/qa`: Drives a real browser to crawl application flows, identifies bugs, writes atomic fix commits, and verifies health scores.
- `/qa-only`: Same methodology as `/qa` but audit-only (no code changes).
- `/browse`: Fast browser automation and screenshot verification via Antigravity's native `browser_subagent`.
- `/ship`: Fully automated ship pipeline: runs tests, reviews diff, bumps version, generates changelog, creates bisectable commits, pushes, and opens PR.
- `/document-release`: Synchronizes README, ARCHITECTURE, and AGENTS.md with what was shipped.

## How to Run in Antigravity
1. **Before merging or finalizing code**: Run `/review` to catch production bugs.
2. **For web/UI features**: Run `/qa` using Antigravity's `browser_subagent`.
3. **To release**: Run `/ship` followed by `/document-release`.
