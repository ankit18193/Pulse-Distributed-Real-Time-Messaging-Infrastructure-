---
name: freeze
description: >-
  Directory edit restrictor: Locks file modifications strictly to an allowed directory path to prevent scope creep during focused edits. Use when restricting modifications to a specific subsystem.
---

## When to invoke this skill

Blocks Edit and
Write outside the allowed path. Use when debugging to prevent accidentally
"fixing" unrelated code, or when you want to scope changes to one module.
Use when asked to "freeze", "restrict edits", "only edit this folder",
or "lock down edits".


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

## Setup

Ask the user which directory to restrict edits to. Use ask_question:

- Question: "Which directory should I restrict edits to? Files outside this path will be blocked from editing."
- Text input (not multiple choice) — the user types a path.

Once the user provides a directory path:

1. Resolve it to an absolute path:
```bash
FREEZE_DIR=$(cd "<user-provided-path>" 2>/dev/null && pwd)
echo "$FREEZE_DIR"
```

2. Ensure trailing slash and save to the freeze state file:
```bash
FREEZE_DIR="${FREEZE_DIR%/}/"
eval "$(~/.agents/skills/bin/gstack-paths)"
STATE_DIR="$GSTACK_STATE_ROOT"
mkdir -p "$STATE_DIR"
echo "$FREEZE_DIR" > "$STATE_DIR/freeze-dir.txt"
echo "Freeze boundary set: $FREEZE_DIR"
```

Tell the user: "Edits are now restricted to `<path>/`. Any Edit or Write
outside this directory will be blocked. To change the boundary, run `/freeze`
again. To remove it, run `/unfreeze` or end the session."

## How it works

The hook reads `file_path` from the Edit/Write tool input JSON (shared
real-JSON extractor with /careful — one copy, sourced by both hooks), then
checks whether the path starts with the freeze directory. If not, it returns a
`hookSpecificOutput` payload with `permissionDecision: "deny"` to block the
operation (nested under `hookSpecificOutput` — Claude Code ignores a top-level
`permissionDecision`).

Polarity is fail-closed: a tool payload the hook cannot parse is DENIED, not
allowed — a boundary that fails open is not a boundary. A payload that parses
but has no `file_path` (a non-file tool) is allowed. Symlinks are resolved
through their FINAL component, so an in-boundary symlink pointing outside the
boundary is checked against its target.

The freeze boundary persists for the session via the state file. The hook
script reads it on every Edit/Write invocation. Boundaries containing spaces
are supported.

## Notes

- The trailing `/` on the freeze directory prevents `/src` from matching `/src-old`
- Freeze applies to Edit and Write tools only — Read, Bash, Glob, Grep are unaffected
- This prevents accidental edits, not a security boundary — Bash commands like `sed` can still modify files outside the boundary
- To deactivate, run `/unfreeze` or end the conversation
