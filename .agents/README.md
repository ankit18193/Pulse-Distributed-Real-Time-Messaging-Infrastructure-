# GStack Engineering Workflow for Google Antigravity

This directory contains the **Garry Tan gstack engineering workflow** integrated locally into Pulse for **Google Antigravity**.

## Overview
- **Source of Truth**: Upstream gstack (`https://github.com/garrytan/gstack`).
- **Development Environment**: Google Antigravity.
- **Claude Code Dependency**: **NONE**. Pulse does not use Claude Code, requires no Claude subscription, has no Claude CLI binary dependency, installs nothing to `~/.claude`, and has zero runtime dependencies on gstack.
- **Runtime Isolation**: gstack is strictly a development workflow layer. It never appears in production Docker images, WebSocket servers, Redis runtimes, RouteX gateways, or production environment variables.

## Directory Structure
```
Pulse/
├── .agents/
│   ├── ETHOS.md                     # Garry Tan Builder Ethos (Boil the Ocean, Reuse Ladder)
│   ├── README.md                    # Integration & adaptation documentation
│   ├── skills/                      # 26 portable Antigravity skills
│   │   ├── office-hours/
│   │   ├── plan-ceo-review/
│   │   ├── plan-eng-review/
│   │   ├── plan-design-review/
│   │   ├── plan-devex-review/
│   │   ├── plan-tune/
│   │   ├── autoplan/
│   │   ├── design-consultation/
│   │   ├── spec/
│   │   ├── review/
│   │   ├── investigate/
│   │   ├── design-review/
│   │   ├── qa/
│   │   ├── qa-only/
│   │   ├── browse/
│   │   ├── ship/
│   │   ├── document-release/
│   │   ├── document-generate/
│   │   ├── health/
│   │   ├── benchmark/
│   │   ├── cso/
│   │   ├── retro/
│   │   ├── careful/
│   │   ├── freeze/
│   │   ├── guard/
│   │   └── unfreeze/
│   └── workflows/                   # Phased engineering lifecycle runbooks
│       ├── 01-ideation-and-planning.md
│       ├── 02-architecture-and-design.md
│       ├── 03-implementation-and-investigation.md
│       ├── 04-review-qa-and-ship.md
│       └── 05-audit-and-retrospective.md
├── AGENTS.md                        # Root project rules discovered by Antigravity
└── ...
```

## Antigravity Adaptation Details
1. **Progressive Disclosure Frontmatter**:
   - Each `SKILL.md` defines standard YAML frontmatter with `name` and comprehensive `description`.
   - Antigravity parses these descriptions to automatically activate the appropriate skill on demand.
2. **Interactive Decision Briefs**:
   - Uses Antigravity's native `ask_question` modal tool and planning mode briefs (Issue, Stakes, Recommendation, Completeness score, Options).
3. **Browser Automation**:
   - Uses Antigravity's native `browser_subagent` (navigation, DOM inspection, clicking, typing, screenshot capture, video recording) and `read_url_content`.
   - Eliminates all Claude browser MCP dependencies.
4. **Tool Mapping**:
   - Bash → `run_command`
   - Read / Write / Edit → `view_file`, `write_to_file`, `replace_file_content`
   - Glob / Grep → `list_dir`, `grep_search`
   - Plan mode → Antigravity Planning Mode (`implementation_plan.md`, `walkthrough.md`)

## Updating from Upstream
To update skills from upstream `garrytan/gstack`:
1. Fetch latest upstream repository changes.
2. Run the adaptation script to refresh `.agents/skills/` while preserving Antigravity frontmatter and removing Claude-specific host scripts.
3. Validate with `node C:\Users\ankit\.gemini\antigravity-ide\brain\<conv-id>\scratch\verify_skills.js`.
