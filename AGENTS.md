# How we build Multiscale

For any agent working in this repo. These are the habits the project was built with. Use judgement inside them, and
when one doesn't fit a case, say so rather than quietly working around it. The `ponytail` and `caveman` skills they
name are in [.claude/skills](.claude/skills): Claude Code loads them from there, and any other agent can read their
`SKILL.md`.

## Building

- **Test first.** Write or extend the failing test, see it fail, then make it pass. A change isn't done until the tests
  that cover it pass where it runs: unit, browser, Mac app, iPhone.
- **The smallest complete change.** This is the `/ponytail` way. Reuse what the codebase already has before adding
  anything. Skip options and abstractions nobody asked for. But finish everything the change touches: callers, tests,
  fixtures, docs. A known limit gets a `// shortcut: <the limit>, <when to upgrade>` comment. Never cut validation at a
  trust boundary, error handling that prevents data loss, security or accessibility.
- **Match the code around you:** its naming, structure and comment density. Comments say why, not what.
- **Check your work as a person would.** Run the app, look at screenshots on desktop and phone, and say plainly what you
  didn't verify.

## Tests

| Layer | Runs | Command |
| --- | --- | --- |
| Local, no deployment | Unit tests; browser e2e at desktop and phone sizes; the Mac app; a Docker stand-in backend for sync; the last release's web bundle beside this one; the iPhone Simulator | `make test`, `make test-e2e`, `make test-compat`, `make test-ios` |
| Against a deployment | The deployed web app, sync, on staging the last release's web bundle beside this one, the integration suite, smoke, the iPhone signed-in test | `make test-deployed` (staging), `ENV=prod CONFIRM_PROD=yes` |
| CI | Everything in the local layer, on every push and PR | `.github/workflows/ci.yml` |
| Release | `make release` runs `make test-deployed` against what it just released | `scripts/release.sh` |

**Anything you check by hand belongs in a layer.** That includes a scratch script, a device check, or a curl. Add it
to the right layer in the same change, or say why it can't be automated.

## The product's rules

- **Nothing happens to someone's plan without them.** Time is placed, and tasks are finished, only by an explicit action.
  Suggestions are shown, never saved.
- **Every change can be undone,** usually from the toast that reports it.
- **Copy is plain and specific,** in sentence case, and says what happened.
- **Accessibility is part of done:**
  - controls named in full;
  - 44pt tap targets on phone;
  - focus that lands somewhere sensible;
  - `prefers-reduced-motion` respected.

## The repo and releases

- **This repo is public and holds code only.** No secrets, real names, emails, account IDs, domains or team IDs: not in
  code, commits, PRs or docs. Deployment config lives in a private config folder (`MULTISCALE_CONFIG_DIR`), and release
  keys are never committed.
- **Work on a branch and open a PR.** Never push or merge to `main`, deploy or release to prod, or create repositories
  unless the owner has said to.
- **Commit messages and PRs are plain prose:** a summary line, then what changed for the person using the app, and why.

## Working with the owner

- **In chat, be terse:** the answer first, every fact kept, no filler. This is the `/caveman` voice. Code, comments,
  commits, PRs and docs are written in plain, full sentences.
- **Decide what's yours to decide,** and say what you decided. Ask only when the choice is genuinely the owner's.
- **When the owner says they've done a step, take it as done.**
- **Report outcomes as they are:** failing tests with their output, and steps skipped.
