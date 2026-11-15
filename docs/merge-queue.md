# The merge queue

Main takes pull requests through GitHub's merge queue, once it's turned on as below. A pull request whose checks have
passed joins the queue. The queue merges it onto main, together with any pull requests ahead of it, and runs CI on that
commit. When main's required checks pass there, it fast-forwards main to that same commit. Nobody has to update a branch
and wait for CI again before merging, and main still only gets commits whose required checks passed on exactly the code it
ends up with. Until the queue is on, pull requests have to be up to date with main before they merge, so each merge
means updating the branch and running CI again.

## Before turning it on

- **The repository must belong to an organization.** GitHub offers the merge queue only on repositories an organization
  owns: public ones, or private ones on GitHub Enterprise Cloud. It isn't offered on a repository under a personal
  account. A free organization is enough for a public repository. Moving the repository there also changes these, outside
  this repository:
  - The release pipeline. It names the repository in `control.yaml`'s `pipeline.repository`, and its GitHub
    connection needs the AWS connector app installed for the organization. After changing the name, run
    `make deploy ENV=pipeline` again.
  - The role the Mac release and the TestFlight review assume. It trusts GitHub's OIDC tokens for
    `repo:<pipeline.repository>:environment:release`, or for `pipeline.mac.githubSubject` when that's set. A subject with
    ids in it has the owner's id, which changes.
  - The CLA document's address in `.github/workflows/cla.yml`. GitHub redirects the old one, as it does for clones.
- **Merge the change that adds the `merge_group` triggers first**, the usual way. Every workflow behind a required check
  must run for merge groups, or the queue waits on a check that never starts until it times out.
  `infrastructure/test/merge-queue.test.ts` holds the workflows to the ruleset below.

## Turning it on

The ruleset is [.github/rulesets/main.json](../.github/rulesets/main.json). From a checkout, as a repository admin:

```sh
gh api -X POST repos/{owner}/{repo}/rulesets --input .github/rulesets/main.json
```

Or import the file under **Settings > Rules > Rulesets > New ruleset > Import a ruleset**. The ruleset also takes over
what main's classic branch protection does today, so once the ruleset is active, remove the classic protection. Otherwise
its "Require branches to be up to date" setting still applies alongside the queue:

```sh
gh api -X DELETE repos/{owner}/{repo}/branches/main/protection
```

What the ruleset sets, and why:

| Setting | Value | Why |
| --- | --- | --- |
| Applies to | The default branch, `main` | |
| Merge method | Merge commit (`MERGE`) | Main's history keeps its "Merge pull request #N from <owner>/<branch>" commits |
| Only merge non-failing pull requests | On (`ALLGREEN`) | Every pull request in a group must pass on its own commit, so a failing one never merges behind a green one |
| Build concurrency | 3 (`max_entries_to_build`) | Each group runs all of CI, about ten Linux jobs. GitHub's free plan runs 20 Linux jobs at once, shared with pull requests' runs |
| Group size | 1 to 5 (`min_entries_to_merge`, `max_entries_to_merge`) | A pull request merges as soon as its group passes, without waiting for others. Up to 5 that are all green merge in one push |
| Wait for the minimum group size | 0 minutes | With a minimum of 1 there's nothing to wait for |
| Status check timeout | 60 minutes | The required jobs take about 15 minutes, so this leaves room for a wait for runners. A group whose checks haven't finished by then leaves the queue |
| Required checks | `secret-scan`, `cla`, `frontend`, `backend`, `infrastructure`, `local-suite`, `e2e-stack`, `e2e-browser`, `e2e-electron`, `e2e-compat`, each from GitHub Actions | The same checks main requires today. `ios` isn't one: it runs only when its inputs change and takes about 40 minutes |
| Require branches to be up to date | Off | The queue tests each pull request on the main it merges onto, which this setting did by hand |
| Deletion and force pushes | Blocked | As today |
| Bypass | Repository admins | As today, where the classic protection doesn't apply to admins |

## Merging a pull request

- **On GitHub:** **Merge when ready**, then **Confirm merge when ready**. A pull request whose required checks haven't
  passed yet waits, and joins the queue once they do.
- **From the command line:** `gh pr merge <number>`. If the required checks have passed, it adds the pull request to the
  queue. If they haven't, it turns on auto-merge, and the pull request joins once they pass. `--auto` does the same.
  Don't pass `--admin`: it merges straight to main, around the queue.
- **To take one out:** **Remove from queue** on the pull request, or on main's queue page (the **Merge queue** link on the
  branch's list of pull requests).

The queue removes a pull request whose group fails a required check or times out, and rebuilds the groups behind it
without it. Fix it, and it can join again. The `ios` job runs on a group only when the group changes something the
iPhone app is built from or runs (`scripts/ci-changes.sh`). It doesn't hold up the queue, and main runs it again after
the merge.

## What changes on main

- **Commit messages stay as they are:** the merge commit's subject is still "Merge pull request #N from
  <owner>/<branch>", with the pull request's title as its body, since the queue uses the repository's default merge
  message. Main gets the group's own commit, the one CI tested. The "Merge branch 'main' into <branch>" commits that came
  from updating branches stop.
- **Several pull requests can reach main in one push.** Everything that runs on a push to main then runs once, for the
  newest commit: CI, the Mac release, TestFlight, and the release pipeline, which already builds only the newest commit.
- **A commit's time is when its group was made, not when it reached main,** and the commits of pull requests queued at
  the same moment can share a second. TestFlight numbers a build by its commit's time (`scripts/testflight.sh`). If the
  newest commits of two separate pushes share a second and both change the iPhone's native code, the second push uploads
  nothing. The first push's build then can't be traced to one commit, so the iPhone feed doesn't switch to it. The next
  push to main uploads a build of its own, which sorts it out. Until then, the iPhone app's native change waits.
