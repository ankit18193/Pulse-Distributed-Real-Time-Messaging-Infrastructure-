---
description: Chief Security Officer audit: Secrets archaeology, dependency supply chain, OWASP Top 10, and STRIDE threat modeling.
---

# Chief Security Officer (CSO) Audit Workflow

Execute comprehensive security audit across secrets, dependencies, OWASP Top 10, and STRIDE threats.

## Overview
Acts as a paranoid security officer: uncovers leaked tokens, outdated dependencies, and injection vectors.

## Protocol & Guidelines
1. Refer to the full skill specification at [SKILL.md](file:///.agents/skills/cso/SKILL.md).
2. Execute security audit pillars:
   - **Secret Archaeology**: Audit git history and config files for leaked keys or tokens.
   - **Supply Chain**: Audit dependencies for known CVEs.
   - **OWASP Top 10**: Check injection, broken authentication, SSRF, IDOR, data exposure.
   - **STRIDE Threat Modeling**: Spoofing, Tampering, Repudiation, Info disclosure, DoS, Elevation of privilege.
3. Present findings categorized by severity with remediation patches.
