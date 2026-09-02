---
name: unfreeze
description: >-
  Safety boundary release: Clears active freeze and directory restriction locks, returning the workspace to unrestricted editing. Use when lifting directory edit locks.
---

## When to invoke this skill

Use when you want to widen edit scope without ending the session.
Use when asked to "unfreeze", "unlock edits", "remove freeze", or
"allow all edits".


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

## Clear the boundary

```bash
eval "$(~/.agents/skills/bin/gstack-paths)"
STATE_DIR="$GSTACK_STATE_ROOT"
if [ -f "$STATE_DIR/freeze-dir.txt" ]; then
  PREV=$(cat "$STATE_DIR/freeze-dir.txt")
  rm -f "$STATE_DIR/freeze-dir.txt"
  echo "Freeze boundary cleared (was: $PREV). Edits are now allowed everywhere."
else
  echo "No freeze boundary was set."
fi
```

Tell the user the result. Note that `/freeze` hooks are still registered for the
session — they will just allow everything since no state file exists. To re-freeze,
run `/freeze` again.
