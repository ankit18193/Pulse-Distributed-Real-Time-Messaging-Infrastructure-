# Pulse — Distributed Real-Time Messaging Infrastructure

This project is developed using **Google Antigravity** and uses the **Garry Tan gstack engineering workflow** as its core development and engineering methodology.

---

## Important Architectural Rules

1. **Google Antigravity is the Development Environment**:
   - All agent interactions, planning, tool executions, browser testing, and reviews run natively in Google Antigravity.
2. **Claude Code is NOT Required**:
   - Do NOT install or require Claude Code.
   - Do NOT install anything into `~/.claude`.
   - Do NOT configure Claude Code hooks, commands, plugins, or MCP tools.
   - Pulse has ZERO dependencies on Claude Code or Claude API keys.
3. **gstack is ONLY a Development Workflow Layer**:
   - gstack is a developer methodology layer located in `.agents/`.
   - It is **NOT** a Pulse runtime dependency.
   - Pulse production code, Docker images, WebSocket servers, Redis Pub/Sub, RouteX edge gateway integrations, and production environment variables must **NEVER** depend on gstack.
4. **Mandatory Workflow Gates**:
   - **Before major architectural implementation**: Run `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`, or `/autoplan` to lock in requirements and data flow.
   - **Before major infrastructure changes**: Run `/plan-eng-review` to evaluate edge cases, failover modes, connection limits, and failure blast radius.
   - **Before considering a phase complete**: Run `/review` and `/qa` to audit code quality, concurrency, security, and verification evidence.
   - **For root cause debugging**: Run `/investigate` before writing speculative fixes.

---

## GStack Builder Ethos

See [.agents/ETHOS.md](file:///.agents/ETHOS.md) for full details:
- **Boil the Ocean**: AI makes completeness cheap. Do the complete thing: full test coverage, error paths, and edge cases. Shortcuts require explicit decisions.
- **Search Before Building**: Check what exists before writing new code:
  - *Layer 1 (Tried & True)*: Standard battle-tested patterns.
  - *Layer 2 (New & Popular)*: Modern ecosystem approaches (scrutinize carefully).
  - *Layer 3 (First Principles)*: Deep understanding of the specific problem at hand.
- **The Reuse Ladder**:
  1. A helper, util, or pattern already in this repo.
  2. The standard library.
  3. A native platform feature (e.g. database constraint over app code).
  4. An already-installed dependency.
  5. Only then write new custom code.
- **Voice**: Direct, concrete, builder-to-builder. Name the file, function, line, and user-visible impact. Zero AI filler, no fluff.
- **User Sovereignty**: Models recommend, the developer decides.

---

## Available GStack Skills in Antigravity

Invoke skills via slash command (e.g. `/plan-eng-review`) or natural prompts:

### Plan-Mode Reviews & Ideation
| Skill | Slash Command | When to Use |
| :--- | :--- | :--- |
| **YC Office Hours** | `/office-hours` | Brainstorm ideas, 6 forcing questions on demand reality, wedge validation. |
| **CEO Review** | `/plan-ceo-review` | CEO-level review: find the 10-star product, challenge scope, strategic ambition. |
| **Eng Review** | `/plan-eng-review` | Architecture lock, data flow, failure modes, ASCII diagrams, test matrices. |
| **Design Review** | `/plan-design-review` | 10-dimension design rubric, UI states, aesthetic rating. |
| **DevEx Review** | `/plan-devex-review` | Time-to-Hello-World (TTHW), eliminate friction points, audit onboarding journeys. |
| **Question Tuning** | `/plan-tune` | Tune decision brief sensitivity and preference thresholds. |
| **Auto-Review Pipeline** | `/autoplan` | Runs CEO → Design → DevEx → Eng review sequentially with single approval gate. |
| **Design System** | `/design-consultation` | Build a complete design system (tokens, colors, typography) from scratch. |
| **Spec Author** | `/spec` | Author a formal, phased 5-part engineering specification. |

### Implementation, Debugging & Code Review
| Skill | Slash Command | When to Use |
| :--- | :--- | :--- |
| **Pre-Landing Review** | `/review` | Multi-perspective code review (concurrency, security, data migrations, edge cases). |
| **Root Cause Debugging** | `/investigate` | 4-phase systematic debugging: Reproduction → Instrumentation → Root Cause → Fix. |
| **Live UI Review** | `/design-review` | Live visual audit of spacing, contrast, micro-interactions with atomic commits. |

### Quality Assurance & Browser Testing
| Skill | Slash Command | When to Use |
| :--- | :--- | :--- |
| **QA Test & Fix** | `/qa` | Autonomous browser testing via Antigravity `browser_subagent` + atomic bug fixes. |
| **QA Report Only** | `/qa-only` | Browser audit producing report without modifying source code. |
| **Browser Inspection** | `/browse` | Headless and visual browser automation, navigation, and screenshots. |

### Release, Deploy & Documentation
| Skill | Slash Command | When to Use |
| :--- | :--- | :--- |
| **Automated Ship** | `/ship` | Full ship pipeline: test triage, diff review, version bump, changelog, atomic commits, PR. |
| **Sync Release Docs** | `/document-release` | Update README, ARCHITECTURE, and AGENTS.md to match shipped diffs. |
| **Diataxis Docs** | `/document-generate` | Generate documentation across Tutorial, How-To, Reference, and Explanation modes. |

### Operational, Security & Quality Audits
| Skill | Slash Command | When to Use |
| :--- | :--- | :--- |
| **Code Health** | `/health` | Composite 0-10 score across linters, type checks, test runners, and dead code. |
| **Performance Benchmark**| `/benchmark` | Measure page load speed, Core Web Vitals, payload sizes, and regressions. |
| **Security Audit** | `/cso` | Chief Security Officer audit: secret archaeology, OWASP Top 10, STRIDE threat model. |
| **Weekly Retrospective** | `/retro` | Commit cadence, shipping streaks, velocity analysis, and growth areas. |

### Safety & Scope Guardrails
| Skill | Slash Command | When to Use |
| :--- | :--- | :--- |
| **Destructive Command Guard** | `/careful` | Warn and require confirmation before destructive shell commands (rm -rf, DROP TABLE, force-push). |
| **Directory Edit Lock** | `/freeze` | Restrict file edits to an allowed directory path to prevent scope creep. |
| **Full Safety Shield** | `/guard` | Activate both careful and freeze simultaneously. |
| **Release Safety Lock** | `/unfreeze` | Remove active directory edit restrictions. |

---

## Slash Command Workflows & Lifecycle Runbooks

### 1. Slash Commands (.agents/workflows/*.md)
All 26 workflows are implemented as native Antigravity workflow files in [.agents/workflows/](file:///.agents/workflows/):
- Typing `/` in the Antigravity chat input directly discovers and autocompletes each workflow (e.g. `/office-hours`, `/plan-ceo-review`, `/review`, `/qa`, `/ship`).

### 2. Phased Lifecycle Runbooks (.agents/phases/*.md)
Grouped engineering runbooks are available in [.agents/phases/](file:///.agents/phases/):
- **[01-ideation-and-planning.md](file:///.agents/phases/01-ideation-and-planning.md)**: Product discovery & plan reviews.
- **[02-architecture-and-design.md](file:///.agents/phases/02-architecture-and-design.md)**: Design tokens & specifications.
- **[03-implementation-and-investigation.md](file:///.agents/phases/03-implementation-and-investigation.md)**: Safe implementation & debugging.
- **[04-review-qa-and-ship.md](file:///.agents/phases/04-review-qa-and-ship.md)**: Code review, QA, and automated shipping.
- **[05-audit-and-retrospective.md](file:///.agents/phases/05-audit-and-retrospective.md)**: Quality, performance, security, and retrospectives.
