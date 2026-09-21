# AGENTS.md

This file provides guidance for AI agents (Claude Code, Codex, etc.) working in this repository.

---

## Table of Contents

- [Work Cycle Rules](#work-cycle-rules)
- [Code Comments](#code-comments)
- [Commit & PR Rules](#commit--pr-rules)

---

## Work Cycle Rules

> These rules apply to **every work session** without exception.

### 1. Keep AGENTS.md Up to Date

If a conversation or mid-task decision causes a direction change significant enough to affect `AGENTS.md`, the file must be updated to reflect the latest state.

- **This MD update must be a separate, isolated commit** — never bundled with feature, fix, or refactor commits.
- AGENTS.md is the source of truth for implementation conventions.
- When in doubt whether a change is "significant enough": if it would cause a future agent to make a wrong decision, it is significant enough.

### 2. Pre-Commit / Pre-PR Checklist

Before committing or opening a PR, verify the following:

1. **Conventions followed** — all changes comply with the guidelines defined in this file
2. **Tests added** — appropriate unit tests are written for new or changed logic
3. **Commit discipline** — commits follow the rules in Commit & PR Rules (meaningful units, signed, proper messages)
4. **CI expected to pass** — all checks that run in CI workflows (build, lint, typecheck, format, tests, etc.) pass locally before pushing

### 3. Respect .gitignore

**Never `git add -f` or force-commit a gitignored file.** If a file is in `.gitignore`, it is excluded from version control by design. This applies to all files without exception — `.env`, build artifacts, etc.

---

## Code Comments

**Do not write comments.** If code needs a comment to be understood, rewrite the code.

Exceptions — the only cases where comments are acceptable:

- **Public API docs** (JSDoc, godoc, etc.) — exported functions, types, and packages.
- **Why, not what** — non-obvious business rules, workarounds, or trade-offs that naming and structure alone cannot convey.
- **Warnings** — subtle gotchas or invariants the type system cannot enforce.

---

## Commit & PR Rules

### Commit Discipline

> These rules are critical. Agents must follow them strictly.

- **Keep commits semantic and focused** — each commit should represent one logically complete unit of work. Do not batch unrelated changes.
- **Commit immediately when a unit of work is done** — do not accumulate changes across multiple tasks. As soon as an individual piece of work is complete and passes verification, commit it.
- **Every commit must be CI-passing** — each individual commit must be in a state where the CI pipeline (build, lint, typecheck, tests) would pass. Never create a commit that would break CI, even if a subsequent commit would fix it.
- **Single author per commit** — always commit under the configured repository author. Co-authored commits (`Co-authored-by:`) are not allowed except in explicitly agreed exceptional cases.
- **All commits must be signed** (`git commit -S`). Unsigned commits will not be accepted.
- **Commit Perspective** — all commits must follow the Commit Perspective rules defined below.

### Commit Perspective

Commits are merged as-is via rebase merge (no squash). Every commit lands on `main` individually — each must be a meaningful, self-contained unit that makes sense on its own in the main branch history.

Never include ephemeral context in commit messages or bodies: internal planning references (e.g., `Wave 1`, `T-3`, `Task 2`), session-specific discussions, or intermediate decisions lose meaning once merged to main. Only real issue/ticket numbers (e.g., `#123`, `PROJ-456`) belong in commits. Write commit messages from the perspective of the final state, not the journey.

### Commit Messages

Use **GitHub style**: imperative mood, capitalize first word, no period at end.

```
Add user TOTP enrollment endpoint
Fix refresh token expiry validation
Update user creation DTO validation rules
Remove unused Redis cache keys
```

- Keep subject line under 72 characters.
- Wrap body lines at 72 characters.
- Always add a body when possible (blank line after subject). Explain **why** the change was made, not just what. Be specific but concise.

### Commit Squashing / Rebasing

- When commits within a branch need to be consolidated, use interactive rebase (`git rebase -i`).
- **Only adjacent commits may be squashed** without explicit user approval. Non-adjacent squashing reorders history and must be confirmed with the user first.
- Avoid trivially small commits (e.g., fixing a typo you just introduced) — amend the previous commit or squash before pushing.

### Pull Requests

- **Merge strategy**: Rebase merge (no merge commits, no squash).
- Keep PRs focused — one concern per PR.
- PR title follows the same commit message style.
- Reference related issues in the PR description.
- All checks (lint, type-check, tests) must pass before merging.

### Merge Rules

- **Always check for open PRs first** — before merging, check if there is an open PR on the upstream for the branch being merged.
- **Local fast-forward merge + push** — if an open PR exists, do NOT merge via `gh pr merge` or GitHub MCP tools. Instead, perform a local fast-forward merge (`git merge --ff-only`) on the base branch and push. This closes the upstream PR naturally via push and preserves a clean linear history.
- **Multiple branches → merge one at a time** — when merging several branches in sequence (e.g., `feature-a` → `develop` → `main`), do NOT merge all at once locally. Merge and push each base/destination pair sequentially so that each upstream PR is closed by the corresponding push. Merging everything locally before pushing leaves dangling open PRs on the upstream.
