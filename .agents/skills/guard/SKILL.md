---
name: guard
description: >-
  Full safety shield: Activates both careful (destructive command warning) and freeze (directory edit lock) simultaneously. Use when high safety and tight scoping are required.
---

## When to invoke this skill

Combines /careful (warns before rm -rf, DROP TABLE, force-push, etc.) with
/freeze (blocks edits outside a specified directory). Use for maximum safety
when touching prod or debugging live systems. Use when asked to "guard mode",
"full safety", "lock it down", or "maximum safety".


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

- Question: "Guard mode: which directory should edits be restricted to? Destructive command warnings are always on. Files outside the chosen path will be blocked from editing."
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

Tell the user:
- "**Guard mode active.** Two protections are now running:"
- "1. **Destructive command guard** — rm -rf, DROP TABLE, force-push, etc. warn before executing (overridable); catastrophic shapes (recursive delete of / or ~, force-push to the default branch) are hard-denied"
- "2. **Edit boundary** — file edits restricted to `<path>/`. Edits outside this directory are blocked."
- "To remove the edit boundary, run `/unfreeze`. To deactivate everything, end the session."

## What's protected

See `/careful` for the full list of destructive command patterns and safe exceptions.
See `/freeze` for how edit boundary enforcement works.
