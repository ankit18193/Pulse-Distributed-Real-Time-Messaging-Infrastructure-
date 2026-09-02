---
name: careful
description: >-
  Destructive command guardrails: Enforces warning and confirmation before executing high-risk operations (rm -rf, git reset --hard, DROP TABLE, force push). Use when running risky terminal operations.
---

## When to invoke this skill

Warns before rm -rf, DROP TABLE,
force-push, git reset --hard, kubectl delete, and similar destructive operations.
User can override each warning. Use when touching prod, debugging live systems,
or working in a shared environment. Use when asked to "be careful", "safety mode",
"prod mode", or "careful mode".


## Antigravity Execution Foundation

This skill operates natively in **Google Antigravity**:
1. **Interactive Decision Briefs**:
   - When user choices are required, structure them as decision briefs:
     - **Issue**: Plain English explanation of what is being decided.
     - **Stakes**: What breaks or is impacted if chosen incorrectly.
     - **Recommendation**: Explicit opinionated choice with reasoning.
     - **Completeness**: Rate coverage (`Completeness: X/10`).
     - **Options**: Clear selectable choices (A, B, C...).
   - In Antigravity, present questions using the `ask_question` tool or direct interactive prompt during planning mode.
2. **Native Tooling**:
   - Shell: Use `run_command` (PowerShell / shell).
   - Files: Use `view_file`, `replace_file_content`, `write_to_file`, `grep_search`, `list_dir`.
3. **Engineering Ethos ([ETHOS.md](file:///.agents/ETHOS.md))**:
   - **Boil the Ocean**: AI makes completeness cheap; cover edge cases, error paths, and thorough test cases.
   - **The Reuse Ladder**: Repo util → Standard Library → Platform native → Existing dependency → New code.
   - **Search Before Building**: Verify established patterns before writing custom abstractions.
   - **Voice**: Direct, builder-to-builder, naming exact files, functions, and lines. No AI filler.
4. **Completion Status Protocol**:
   - Finish with clear status: `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, or `NEEDS_CONTEXT`.


---

## What's protected

| Pattern | Example | Risk |
|---------|---------|------|
| `rm -rf` / `rm -r` / `rm --recursive` | `rm -rf /var/data` | Recursive delete |
| `DROP TABLE` / `DROP DATABASE` | `DROP TABLE users;` | Data loss |
| `TRUNCATE` | `TRUNCATE orders;` | Data loss |
| `git push --force` / `-f` | `git push -f origin main` | History rewrite |
| `git reset --hard` | `git reset --hard HEAD~3` | Uncommitted work loss |
| `git checkout .` / `git restore .` | `git checkout .` | Uncommitted work loss |
| `kubectl delete` | `kubectl delete pod` | Production impact |
| `docker rm -f` / `docker system prune` | `docker system prune -a` | Container/image loss |

## Safe exceptions

These patterns are allowed without warning:
- `rm -rf node_modules` / `.next` / `dist` / `__pycache__` / `.cache` / `build` / `.turbo` / `coverage`

## How it works

The hook reads the command from the tool input JSON, checks it against the
patterns above, and returns a `hookSpecificOutput` payload with
`permissionDecision: "ask"` and a warning reason if a match is found (the
decision must be nested under `hookSpecificOutput` — Claude Code ignores a
top-level `permissionDecision`). You can always override a MEDIUM warning and
proceed.

## HIGH tier (hard deny)

Two catastrophic shapes are **denied**, not asked: `rm -r`/`-R` of exactly
`/`, `~`, or `$HOME`, and force-push to the repo's **default branch**. SIMPLE
commands only (no `;`, `&&`, `||`, `|`, newline) — compound shapes fall
through to the MEDIUM ask; `--force-with-lease` is never HIGH. A best-effort
advisory hard-stop, not a policy boundary: the escape hatch is ending the
opt-in, session-scoped /careful session.

## Project patterns (additive only)

Add warn rules — one POSIX ERE per line, `#` comments OK — in
`~/.gstack/careful-patterns.txt` (global) or
`~/.gstack/projects/<slug>/careful-patterns.txt` (per-project). Consulted
after the built-in families, so config can only ADD rules, never suppress a
baseline warning. Invalid regex lines are skipped.

To deactivate, end the conversation or start a new one. Hooks are session-scoped.
