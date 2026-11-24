# Releasing

Every change reaches prod the same way: green CI before it merges to main, then a pipeline that builds that main
commit once, deploys it to staging and tests it there, emails that it passed, and after a window in which the owner
can stop it, promotes the same build to prod. No one needs to approve it. Prod's backend then takes the new version by
canary: 10% of traffic for 5 minutes, with alarms that move it back on their own. A commit that changes the Mac app's native
code gets a new Mac app from GitHub Actions, which the pipeline checks and publishes, once
[set up](#mac-apps-from-github-actions). One that changes the iPhone app's gets a new TestFlight build from GitHub
Actions, and the pipeline switches the iPhone feed once testers can install it
([iPhone apps from TestFlight](#iphone-apps-from-testflight)).

The pipeline is AWS CodePipeline and CodeBuild in the control account (`infrastructure/lib/pipeline-stack.ts`), and its
steps are `scripts/pipeline.sh`. Deploy rights stay in AWS: GitHub's CI holds no AWS credentials. The exceptions are the
Mac release and the TestFlight review, which may only upload to the pipeline's inbox, through GitHub's OIDC token, with
no long-lived key.

## The flow

| Stage | Runs against | What happens | Stops the release when |
| --- | --- | --- | --- |
| **Pull request** | Nothing deployed: the local stack and the iOS Simulator, in GitHub's CI | Unit tests, Go, infrastructure, browser e2e at desktop and phone sizes, the Mac app, the local stack, cross-version, those two again with staging's retention, and iOS when the pull request changes something the iPhone app is built from or runs (`scripts/ci-changes.sh`) | A check fails. Every check must pass before a merge |
| **Mac release** | Nothing: GitHub Actions on macOS, once the owner approves if the `release` environment asks | For each main commit, builds, signs and notarizes the staging and prod Mac apps, and uploads them to the pipeline's inbox | An approval the environment asks for doesn't come, or a build or notarization fails. The pipeline then stops at Staging |
| **TestFlight** | Nothing: GitHub Actions, on macOS to upload and on Linux every hour | For a main commit whose iPhone native code differs from TestFlight's latest build's, uploads the iPhone app to TestFlight for Beta App Review. Every hour, records in the pipeline's inbox the newest build testers can install | Nothing. Until testers can install a build with a release's iPhone native code, the iPhone and shared feeds wait |
| **Build** | Nothing | Builds the Lambdas once and synthesizes staging's and prod's stacks from them. Builds each environment's web app and Mac main process from the same commit | A build or config check fails |
| **Staging** | Staging | Deploys the backend, which takes traffic by staging's canary, 5% for 10 minutes. Beside it, when the build needs a new Mac app, or the downloads host serves none the pipeline checked, waits for GitHub's, of this commit or an earlier one with the same Mac native code, and checks it. Signs staging's feed in the signing step. Runs this commit's web app suite against the web app staging still serves, as prod's Test step does. Then uploads the [version](#versions-and-feeds), switches the web app, publishes any new Mac app, switches each feed that can take the build, and runs the web app, feed, sync, cross-version, integration and smoke suites, and, reported only for now, the same web app checks and journey as the history user, on its five-year account, switching what it switched back if a suite fails | A suite fails, a release alarm rolls the canary back, or a needed Mac app doesn't arrive or fails its checks |
| **Promote** | Nothing | An email: the commit passed staging and goes to prod at a time it gives, unless the owner stops it, with a link to promote it now. Then a wait until that time, or until the link's button is pressed, two hours unless `control.yaml`'s `pipeline.promoteAfter` says otherwise | `make pipeline-stop` during the window |
| **Prod** | Prod | Deploys the backend by prod's canary, 10% for 5 minutes. Runs the web app, integration and smoke suites against the apps people already have. Then signs prod's feed in the signing step, uploads the version and switches the web app, any new Mac app the Staging stage checked, and each feed that can take the build, and checks them, switching them back if a suite fails | A release alarm rolls the canary back, or a suite fails |
| **Nightly** | Staging | CI's performance results published to staging's performance dashboard ([docs/performance.md](performance.md)). Each surface switched back one version and forward again, read back from its host. Then the full deployed suite with the history-scale test, so slow suites never hold up a release. An hour later, the retention suite in a build of its own, since it takes about 50 minutes and the control account allows a build only 45 until its limit is raised: until then that build is cut off and fails every night, without taking the rest's result with it. Each runs only when main has moved since it last passed | Nothing. A failure is emailed |
| **On the Mac** | Prod | `make release-tag`, then the signed apps from that tag, until the Mac release and TestFlight from GitHub Actions are set up | — |

Two suites stay off prod on purpose. Sync, because prod's sign-in only returns to the deployed app. The 4.5 MB load test,
because it sets off prod's throttle alarm. The iPhone's signed-in test needs a Mac, so it runs there: `make test-ios`,
or `make test-deployed`. The integration suite's two full-batch tests, paging and the largest batch, stay off prod too:
nothing removes a record outright, so their 694 records would stay on prod's shared test user as deleted records for
the 30-day deleted period, and every new browser of that user, the deployed web suite's included, downloads them all.

Prod's Test step runs this commit's suites against the web app prod still serves, the release before, and publishes
only once they pass (`DEPLOYED_BEFORE_PUBLISH=1`, which skips the checks of the release's own screens and feeds until it
publishes). Staging's step runs this commit's web app suite the same way first, before it uploads anything, and then
publishes and runs its suites against the new release as before. So a step only the new suite takes, such as clearing
the checks earlier runs left on the test user, meets the web app before it on staging, not first on prod. It adds about
a minute to a staging run.

The history-scale budgets only report for now (`HISTORY_REPORT_ONLY=1`). A missed budget never stops a release.

Staging's own test user holds next to nothing, since its deleted period is minutes, while prod's shared test user holds
tens of thousands of records, where a change takes seconds to read back. So each staging run also signs a desktop
browser in as the history-scale test's user, whose five-year account, about 33,000 records, stays there
(`scripts/test-deployed.sh`, the web app suite's `history` project). A setup project seeds the account first, as
`make test-history` does, with only the live records staging keeps; a rerun writes nothing. Then it checks that the
first sync pulls the whole history, about 67 pages, and fails under 50; that a reload in the middle of a first sync opens
the database again; that the data is on OPFS; the desktop journey, from Capture to the calendar and back, with its
clean-ups; that stretch planning's Save and exit leaves the steps; and that the console stays clean. The account's
records carry no expiry, so a reload of a browser holding them would fill expiries in and send them, and staging's
periods would then remove most of the account. So the main page is never reloaded, and the reload is a browser of its
own that sends nothing once it starts to reload. For now its result is reported and never stops a release; to make it
gate, run it with `run` rather than `report` in `scripts/test-deployed.sh`. It adds about 3 to 6 minutes to a staging
run.

Each web build carries its environment's backend addresses, from its stack's outputs as Build finds them. A release
that changes one of those outputs, such as a new sign-in client, reaches the web app with the run after it.

## Versions and feeds

Every release keeps its version in the environment's release bucket, and each surface serves one: the web app, and a
feed each for the Mac and iPhone apps. A release first uploads the version, which changes nothing anyone sees, then
switches each surface to it (`upload` and `switch` in `scripts/pipeline.sh`, which `scripts/release.sh` uses too).

| Path | Holds | Served |
| --- | --- | --- |
| `versions/<version>/web/` | The build's files outside `assets/`: `index.html`, `version.json` and the rest | No |
| `versions/<version>/release.json` | That build's signed feed | No |
| `web/assets/` | Every version's assets, named by their contents, cached for a year | Web host |
| `web/index.html` and the rest | A copy of the version web serves | Web host |
| `release/files/` | Every version's files, named by their contents, cached for a year | Release host |
| `release/desktop/release.json`, `release/iphone/release.json` | A copy of the Mac's and the iPhone's version's feed, cached for 60 seconds | Release host |
| `release/release.json` | For bundles from before the apps' own feeds: a feed that names no native code, so they say they need a new app | Release host |
| `downloads/mac/<app version>/` | Each checked Mac app: its zip, the zip's blockmap, its disk image, then `latest-mac.yml`, written once and cached for good | Downloads host |
| `downloads/Multiscale.dmg` | A copy of the disk image of the app the desktop feed names, for first installs, cached for 5 minutes | Downloads host |
| `mac/manifest.json` | The record of the checked Mac app that's live, with its app record | No |
| `state/history.json` | Each surface's versions in the order it got them, with times | No |

A version is what its `version.json` names: the package version and the commit, such as `0.1.0-85e85c2`. Switching web
copies its page to `web/` with `no-cache`, `version.json` last, so the next page load gets it. Switching a feed copies
its `release.json`, and each device takes it at its next check.

**The Mac app's record.** Where the pipeline checks Mac apps, every manifest names the Mac app that runs its build, as
`app`: the app's version, `0.1.<build>`, so it only goes up; its build and native code; its folder on the downloads
host, `mac/<app version>/`; and the zip there, with its SHA-512 and size. The MacApp step writes the record, from the
zip it checked or, for a build that needs no new app, from the live one in `mac/manifest.json`, and the signing step
signs it with the rest, refusing a record for other native code than the build's. So a release that changes no native
code still names the app that runs it. Nothing under `downloads/mac/` changes once written, so the signed feed is the
only thing that points at an app. Switching the desktop feed to a version that names an app first copies that app's
disk image to `downloads/Multiscale.dmg` and its record to `mac/manifest.json`.

A feed takes a build only when its app can. The desktop feed compares the Mac app's native code with what it serves,
and takes the build when it's unchanged or a Mac app from GitHub Actions is published first. The iPhone feed compares
the iPhone app's, and takes the build when it's unchanged or the newest TestFlight build testers can install has it.
Each release checks every feed it switched: the manifest checks out with the environment's release key, names the
version, and lists only files that download with their SHA-256 (`frontend/e2e/deployed/feed.spec.ts`).

For now every surface switches in one step, staging's and prod's Release. Each bundle reads its own app's feed, and the
files from `release/files/`, which both feeds share.

Bundles from before 10 November 2026 read a shared feed, `release/release.json`, which switched only when both apps
could take a build. None of them can take one now, so each release writes it as a feed that names its version and no
native code, unsigned and listing no files. An app still running one of those bundles then says the update needs a new
version of the app, and the Mac app offers the disk image, which is the last install by hand; nothing installs from it.
The feed test checks the release host serves it so. Between 14 and 16 November 2026 releases deleted it instead, and
those apps said only "Couldn't check for updates".

## The backend canary

Each Lambda (the API, the calendar worker, retention) has a `live` alias, and everything that invokes one goes through
it. A deploy that changes a Lambda publishes a new version, and CodeDeploy moves the alias to it in steps:

1. **Before any traffic,** for the API, the release canary (`cmd/canary`) calls the new version directly. That is a sync
   round trip as a made-up user of its own. If it fails, the deploy stops with nothing shifted.
2. **A share of traffic for a while:** prod sends 10% of invocations to the new version for 5 minutes (`stack.canaryMinutes`; 5 while the beta's features are built), and staging 5%
   for 10. The shares and times are in `config/env/<env>.yaml`. CloudFormation waits about 2 hours for the alias, then
   rolls the stack back, so a canary can't be much longer than 90 minutes: prod's was a day until every release timed out.
3. **All of it,** once no release alarm has fired.

Any release alarm on the way moves the alias back at once, with no one watching. The alarms are API 5xx rate, API p99
latency, Lambda errors, calendar run failures, the retention consumer falling behind, a failed canary run, and on prod,
DynamoDB throttling the API's own requests. They watch both versions together.

**Throttles stop releases on prod only.** The throttle alarm counts the operations the API and the worker make
(`Query`, `BatchGetItem`, `TransactWriteItems`, `PutItem`, `UpdateItem`), by DynamoDB's `ThrottledRequests` for each,
and not staging's cleanup, whose scan and deletes pace themselves. On staging it still emails, but it doesn't stop a
release: staging's test load, such as the history seed and the integration suite's largest pushes, goes through the API
and can throttle at any time, so a throttle there says nothing about the release. `stack.throttleReleaseAlarm` in
`config/env/<env>.yaml` sets it.

**An alarm already firing stops a release before it starts.** CodeDeploy checks the release alarms as a deployment
begins, not only during it, and refuses to start while any is in ALARM, however long it has been. Usually that's right:
the environment is already unhealthy, and a canary can't judge a new version against it. For the fix to what is firing,
see [Shipping while a release alarm fires](#shipping-while-a-release-alarm-fires).

With one real user, 10% of 5 minutes' requests is a handful and might miss what breaks. So a schedule also runs the
release canary every 5 minutes against the alias. That is about 18 runs in a canary, about 2 of them on the new
version at 10%, after the check before traffic has already run it once. One failed run is enough to roll back.

**What a canary can't cover.** It splits traffic between two versions of code. Everything else lands all at once: table,
index, stream and TTL settings, IAM, schedules, and the config files the Lambdas read. Those follow the compatibility
rules in AGENTS.md, and a risky one ships as its own release, ahead of the code that needs it.

**The web app and the feed** aren't split by traffic. They are published only after the backend has all its traffic,
and each device's 20-second trial and rollback protects it from a bundle that won't start.

## Skipping the canary

`make promote CANARY=skip` starts a run that sends prod's new backend all its traffic at once, rather than 10% for 5 minutes.
It still deploys and tests staging first, still waits out the window before prod, and keeps prod's check before traffic, the alarms,
the automatic rollback and the suites. Use it for:

- a fix that can't wait for the canary;
- a release whose old and new code can't run side by side, which the compatibility rules should make rare.

**An agent may skip the canary only with the owner's explicit go-ahead, for that release, each time.** Say why in the
PR or the release notes.

`make deploy ENV=prod CANARY=skip` does the same for a deploy from the Mac.

## Shipping while a release alarm fires

`make promote ALARMS=off` starts a run whose deploys turn the release alarms off, on staging and prod, so CodeDeploy
starts while one is firing. It's for the fix to what is firing, which would otherwise be refused like any release.

- **What stays:** staging's tests, the window before prod, prod's check before traffic, the canary unless it's skipped too,
  rollback when a deployment or that check fails, the suites, and the alarms themselves, which still email.
- **What goes, for that release only:** CodeDeploy reading the alarms, so none stops or rolls back the new version.
  Watch the alarms by hand until the release has all its traffic.
- **The next release turns them on again:** every deploy sets the deployment groups' alarms explicitly from its own
  switches, so a deploy without `ALARMS=off` restores them.

**An agent turns the alarms off only with the owner's explicit go-ahead, for that release, each time.** Say which alarm
is firing and why the release fixes it, in the PR or the release notes.

The release records it: the email before prod shows the run's canary and alarm settings, the release tag's note says
"Release alarms off.", and a deploy from the Mac writes `alarms: off` to `<env>.deployed`.
`make deploy ENV=<env> ALARMS=off` does the same for a deploy from the Mac.

## Rolling back

- **During a canary:** an alarm moves the alias back by itself. To stop one by hand, choose **Stop and roll back
  deployment** on the deployment in CodeDeploy, in prod's account. The pipeline's run then fails, and nothing after it
  is published.
- **After promotion:** revert the bad commit on main and let it release. A fix that can't wait for the canary can skip
  the canary.
- **The web app, or one app's feed:** switch it back to a version kept, as below.
- **When prod's suites fail after its release publishes,** the release switches the web app and each feed it switched
  back to what they served before, which prod's Test step had just passed against the new backend, and the run fails.
  The Test step runs the same suites before each release publishes, so a release left live after failing them would
  fail every later run there, the fix's too: on 16 November prod's desktop feed named a Mac app its downloads host
  didn't have, and every run stopped at Test until the feed was switched back by hand. Staging does the same, since its
  step runs the web app suite against what staging serves before each release publishes there.

### One surface at a time

`make release-surface ENV=prod SURFACE=web|desktop|iphone VERSION=<version>` switches one surface to a version the
bucket keeps, signed in with the environment's profile as `make release` is. Without `VERSION`, it lists what each
surface serves, each one's last versions with their times, and the versions kept. The pipeline switches with the same
code (`scripts/pipeline.sh`).

| Surface | To roll back | What it changes |
| --- | --- | --- |
| Web | Switch to the version before | Every page loaded from then on, within seconds |
| The Mac or iPhone feed, to stop a version spreading | Switch the feed to the version before | Devices that haven't taken the bad version won't. Devices that have keep it |
| The Mac or iPhone apps, to take a version back | Revert on main and let it release: a newer build with the old code | Every device, at its next check after that run reaches it |
| A Mac app that's spreading | Switch the desktop feed to the version before, then revert on main | Macs that haven't got the bad app get the version before's, and `downloads/Multiscale.dmg` is that app's disk image again |

A feed switch only stops a bad version spreading, because the apps never take an older bundle than the one they have:
the page skips a release whose build isn't newer (`frontend/src/core/updates.ts`), and the Mac and iPhone install only
a newer bundle and always run the newest they have. A device that already took the bad one keeps it, unless it failed
its 20-second trial, which rolls it back on that device by itself. A revert on main is a newer build with the old code.

It refuses a version that isn't kept, and, for a feed, a version built for other native code than the apps that feed
serves, since they couldn't take it, but for the desktop feed going to a version whose manifest names a Mac app the
downloads host has: Macs then update to that app, forward or back. The iPhone feed never crosses native code. Web has
no such guard: a browser loads whatever page is live. The compatibility
test checks the bundle a release replaces against the new one, so going back one version is tested. Going back further
is the owner's call, and the command says so.

Every night, staging's run switches the web app and each app's feed back one version and forward again with the same
code, and reads each back from its host. The desktop feed goes back across native code too when the version before
names an app.

When a release alarm is already firing as a deploy starts, CodeDeploy refuses the deploy, and CloudFormation rolls it
back. To ship the fix for it, see [Shipping while a release alarm fires](#shipping-while-a-release-alarm-fires).

## Steering it

All of these run on the Mac, signed in with `control.yaml`'s profile:

| Command | Does |
| --- | --- |
| `make pipeline-pause` | Main commits stop at Build: each run they start stops itself. The switch is the SSM parameter `/multiscale/pipeline/paused` |
| `make pipeline-resume` | Each main commit releases to staging again |
| `make pipeline-stop` | Stops the run waiting in its window before prod, abandoning it and ending its window, so its Promote now link no longer works, and says which commit it stopped. Staging keeps that commit; prod never gets it |
| `make promote` | Starts a run by hand, which the pause lets through. `COMMIT=<sha>` picks the commit (default: the branch's latest). `CANARY=skip` and `ALARMS=off` are above |
| `make release-surface` | Lists what each surface serves and the versions kept, or switches one surface to a version kept: [One surface at a time](#one-surface-at-a-time) |
| `make release-tag` | Tags the commit prod last released as `release-<date>`, noting a skipped canary or the alarms off, and pushes the tag |
| `make pipeline-config` | Uploads the config folder's files the pipeline reads: `control.yaml`, `staging.yaml`, `prod.yaml`, and each release key's public half. Each key itself goes where only the signing step reads it |
| `make deploy ENV=pipeline` | Deploys the pipeline itself |

**Promotion needs no approval.** When staging passes, a state machine (Step Functions, so the wait costs no build
minutes) emails the commit and the time it goes to prod, then waits until that time. To send it sooner, open the
email's link and choose **Promote now**: the run goes to prod at once. Opening the link alone changes nothing, since
mail scanners open links, but anyone with it can promote that run, so don't forward the email. To keep it from prod,
run `make pipeline-stop` before then: it also ends the window, so the link stops working. **Stop execution** on the run
in CodePipeline keeps it from prod too, but leaves the link saying it promoted. **An agent stops a run only when the
owner asks in chat.** The window is `pipeline.promoteAfter` in `control.yaml`, an ISO 8601 duration of
whole days, hours, minutes and seconds up to 6 days: `PT2H` when it's left out, `PT0S` to go at once. Prod's canary and
its alarms still guard the release. Failed runs and failed nightly runs are emailed to the same address. The pause
switch is unchanged: it holds back new runs, not one already past staging.

**The signed apps.** Each build names the native code it needs, and the pipeline compares that with the feed's. When
the Mac app's changed, the pipeline publishes the Mac app GitHub Actions built and checked, then the feed, so an
older app that can't take the new bundle is offered the new app instead
([Mac apps from GitHub Actions](#mac-apps-from-github-actions)). When the iPhone app's changed, the pipeline switches
the iPhone feed once testers can install a TestFlight build with the new native code, which GitHub Actions uploads, so
an older app is told to update from TestFlight ([iPhone apps from TestFlight](#iphone-apps-from-testflight)). Until
then, and when the Mac app's changed without the Mac release set up, the pipeline leaves the feed alone and says so.
For the Mac app, after the release reaches prod, run `make release-tag`, then `git checkout <tag>` and
`make release ENV=prod`. That builds and signs the Mac app on the Mac and uploads it, then the feed. Once its tests
pass, it uploads the iPhone app from the same commit to TestFlight; `SKIP_TESTFLIGHT=1` leaves that out, as it may once
GitHub Actions uploads them ([setup.md](setup.md#testflight)).

## Setting it up

Once. The steps marked **by hand** need the AWS console or your own credentials.

1. **The config.** Add the `pipeline` section to `control.yaml` in your config folder, as `config/control.example.yaml`
   shows: the GitHub repository, the branch, the email for the notice before prod and for failures, and if you like,
   the window before prod, `promoteAfter`.
2. **Trust the control account (by hand).** Bootstrap staging and prod again so the pipeline may deploy there through
   CDK's roles. This is CDK's own cross-account setup:

   ```sh
   cd infrastructure
   control=$(aws sts get-caller-identity --profile multiscale-control --query Account --output text)
   for p in multiscale-staging multiscale-prod; do
     AWS_PROFILE=$p npx cdk bootstrap --trust "$control" \
       --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
       "aws://$(aws sts get-caller-identity --profile $p --query Account --output text)/<region>"
   done
   ```

   Through these roles CloudFormation may do anything in the account, so only the pipeline's two deploy steps, staging's
   deploy and prod's assets, may use them, as `multiscale-pipeline-deployer`. They run the CDK command line on the
   Build output's assemblies and nothing of the app's. The steps that install and run the app's npm packages, the
   build, the suites and the Mac check, sign in as `multiscale-pipeline`, which may assume only each environment's
   release role.
3. **Each environment's release role.** `make deploy ENV=staging`, then `make deploy ENV=prod`. With the `pipeline`
   section in place, each gets the `multiscale-release` role the pipeline tests and publishes as.
4. **The pipeline.** `make deploy ENV=pipeline`. It makes the KMS key the release keys are uploaded with.
5. **The pipeline's config.** `make pipeline-config`.
6. **Authorise GitHub (by hand).** In the control account, open Developer Tools > Settings > Connections. Choose
   `multiscale-github`, which is Pending, then **Update pending connection**. Sign in to GitHub and install the AWS
   Connector app on the repository only.
7. **Confirm the email (by hand).** Open the email from AWS Notifications and choose **Confirm subscription**, or
   the notice before prod won't reach you.
8. **The first run.** `make promote`. It goes to prod when its window ends, unless you stop it.
9. **Mac apps from GitHub Actions,** if you like: [below](#setting-up-the-mac-release).

## Mac apps from GitHub Actions

A commit that changes the Mac app's native code, such as Electron's main process, a native package's version, or the
backend addresses the app allows, needs a new Mac app before installed apps can take its bundle. So does an
environment whose downloads host serves no Mac app the pipeline checked, such as one released before GitHub Actions
built them. GitHub Actions builds it, since signing and notarizing need macOS, and the pipeline checks it on Linux
before publishing it. The pipeline never trusts GitHub's word for any of it.

1. **GitHub Actions builds it.** `.github/workflows/mac-release.yml` runs for every push to main, so the app is in the
   inbox whenever a release needs one, or by hand for a main commit:
   `gh workflow run mac-release.yml -f commit=<full commit hash>`. A first job, with no secrets, checks that the commit
   is on main. The signing job then runs in the `release` environment, after the owner's approval if the environment
   has a reviewer. It installs the lockfile's packages with no install scripts, imports the Developer ID into a keychain
   of its own, builds the staging and prod apps with `scripts/mac-app.sh`, each as a disk image and a zip of the same
   app (signed, notarized and stapled, and the zip unpacked with `ditto` and that copy checked by `codesign`, opened by
   `spctl`, its ticket validated and started, as `make release` does), and writes a manifest beside each: the commit,
   the versions, the app's version, the shell hash, SHA-256s and the notary submissions. It uploads the disk image, the
   zip, its blockmap and the manifest to `s3://<inbox bucket>/inbox/<commit>/<env>/`, the manifest last, and deletes
   the keychain and the notary key.
2. **The pipeline waits for it.** The Staging stage's MacApp step, beside staging's deploy, compares each
   environment's feed with this build, and looks for the record of a checked Mac app beside its downloads. For each
   that needs a new Mac app, it waits for a build in the inbox, up to `pipeline.mac.waitFor` (two hours unless
   `control.yaml` says), then checks the upload (`frontend/scripts/mac-inbox.ts verify`) and writes the app's record,
   which the signing step signs into the manifest. For each that doesn't, it hands on the live app's record instead.
   The build it takes is this commit's own, once its manifest is there, or else the newest of a commit before it whose
   Mac native code is the same (`mac-inbox.ts pick`): the Mac release workflow runs one build at a time and drops the
   one queued whenever main moves on, so with steady merges few commits get their own. The same native code means no
   file the Mac app's shell hash covers differs, and no package it counts changed version (`shell-hash.ts`, the
   paths under `SHELL_SOURCES.electron`: `electron/`, the scripts that compile, build, sign and entitle the app, and
   the web app's files the main process bundles; the packages in `ELECTRON_PACKAGES`), the same test the desktop feed
   applies to bundles. The step then checks out that commit, installs its packages, and builds its web app and main
   process again as the Build step built this one's. Its build must have this build's Mac shell hash, or the step
   leaves that commit's app and waits on. The upload is then checked against that commit's build rather than this
   one's, and an upload that fails is left the same way. A build's version names its commit's first seven characters
   (`vite.config.ts`), so building it again later, in another clone, stamps it the same. A commit from before that took
   git's abbreviation, which grows with the clone's objects, so the step builds it with as many characters as its
   upload's version names (`mac-inbox.ts stamp-length`), and the check still compares every file. The app carries the
   older commit's web bundle, and takes this release's from the desktop feed, as an app with unchanged native code
   does. Prod takes the build of the commit staging's app came from first, if it can, since the staging update check
   passes that app's version. If nothing arrives in time, or this commit's own app fails the check, the run stops
   before anything is published, and before prod. A new AWS account
   caps every CodeBuild build at 45 minutes whatever the project says, until AWS Support lifts it, so the step stops
   waiting at 40 minutes (`CODEBUILD_LIMIT_SECONDS` in `scripts/pipeline.sh`) rather than being cut off without a word.
3. **The releases publish it.** Staging's and prod's releases upload the app's folder first,
   `downloads/mac/<app version>/`: the zip, its blockmap and the disk image, then `latest-mac.yml`, which electron-updater
   reads, written by the pipeline from the record of the checked zip rather than taken from GitHub. A folder already
   finished is left as it is, and a different build of the same version stops the run before it publishes anything.
   Then the disk image goes to `downloads.<zone>/Multiscale.dmg` for first installs, then its manifest to
   `mac/manifest.json` in the release bucket, which nothing serves, as the record that the app is a checked one, then
   the feed. An environment whose
   feed can take the build as its Mac app is, and which serves a checked one, gets no new Mac app, and nothing changes.
   A build that also needs a new iPhone app leaves the iPhone feed until testers can install one
   ([iPhone apps from TestFlight](#iphone-apps-from-testflight)).

### How a Mac app updates itself

An installed Mac app replaces itself with the app a release names (`frontend/electron/appUpdates.ts`), from the first
app that has this code; every app before it is installed by hand once, as the notice it shows says.

1. **The page finds it.** A release whose native code isn't the app's, and whose signed manifest names an app, goes to
   the main process. Without one it's the disk image, as before.
2. **The main process checks it** with the release key inside the app, as it checks a web bundle: a newer build, an
   app record for that native code, and an app that can replace itself where it is. Run from a disk image or a
   temporary copy, it offers Move to Applications. An app the person can't replace, an administrator's, or an older
   app someone went back to, downloads nothing by itself and never installs at quit: Update the app does it on request,
   and macOS asks for a password where it must.
3. **electron-updater downloads it** from the record's folder on the downloads host built into the app, once that
   folder's `latest-mac.yml` says exactly what the signed record does: version, file, SHA-512 and size. It checks the
   zip's SHA-512, including a zip it builds from the blocks that changed, and falls back to the whole zip if that
   doesn't match. `autoDownload`, `allowDowngrade` and `allowPrerelease` are off, and `channel` is never set, since
   setting it turns `allowDowngrade` on. Before it downloads, electron-updater reads the app's
   `Contents/Resources/app-update.yml` for the folder it downloads into. electron-builder writes that file only from a
   publish setting, so `electron/identity.ts` names the downloads host there and `electron-build.mjs` passes publish
   never; the pipeline's check refuses an app without it. Apps built before 17 November 2026 have none, so they can't
   update themselves, and each is installed by hand once more.
4. **Squirrel.Mac installs it** after checking its signature against the running app's Team ID and bundle id: when
   Multiscale quits or the Mac restarts, or at once with Restart to update, in Settings, the sidebar's notice or the
   menu bar menu. Quit installs it and doesn't reopen.
5. **The app reports it.** `app.update.check` carries the outcome or the failure. A Mac that refuses an app for its
   signature reports `app-signature`, which raises the `AppSignature` alarm: the published app is bad. Stop it
   spreading with `make release-surface ENV=prod SURFACE=desktop VERSION=<the one before>`, then revert on main.

**Bumping a bundled package releases a Mac app.** The shell hash covers every package esbuild bundles into the main
process (electron-updater and what it brings), electron-builder, and how the app is built, signed and entitled
(`scripts/electron-build.mjs`, `scripts/mac-signing.ts`, `scripts/entitlements.mac.plist`). `scripts/electron-compile.mjs`
fails the build when it bundles a package `ELECTRON_PACKAGES` in `scripts/shell-hash.ts` doesn't list.

**Checked by hand**, since a runner can't: Gatekeeper's first-launch prompt for a disk image downloaded in a browser,
and translocation, once per major macOS version; the administrator's password dialog, once before shipping; VoiceOver
on macOS's dialogs and the menu bar menu, once.

**How it's tested**, layer by layer:

| Layer | Where | What it shows |
| --- | --- | --- |
| Unit | `src/core/updates.test.ts`, the Settings and sidebar tests | The page: which feed it reads, when a release needs the app, every state and failure it shows |
| Unit | `electron/appUpdates.test.ts` | The main process, with electron-updater stood in for: the signature, the record, where the app runs, and each refusal's code |
| Unit | `scripts/latest-mac.test.ts`, `scripts/sign-release.test.ts` | `latest-mac.yml` and the signed feed as the pipeline writes them, and electron-updater's own parser reading the yml back as the signed record |
| Unit | `scripts/mac-inbox.test.ts`, `electron/identity.test.ts` | The pipeline's check of each Mac app, `app-update.yml` included |
| Integration | `electron/appUpdates.integration.test.ts` | electron-updater's own MacUpdater over HTTP: it reads the pipeline's `latest-mac.yml`, downloads and checks the zip, and hands it to a stand-in for Squirrel.Mac, which fetches it as Squirrel does; a missing folder, a wrong yml, a wrong zip and a missing `app-update.yml` each fail as the app reports them |
| Pipeline | `infrastructure/test/pipeline-script.test.ts`, `mac-update-check.test.ts` | What each release publishes and in what order, when the desktop feed waits, and the update check's choice of app to update from |
| Deployed | `e2e/deployed/feed.spec.ts`, on every release | Each feed checks out with the release key, the root feed names no native code, and the desktop feed's app is on the downloads host as `latest-mac.yml` says |
| macOS | `scripts/mac-update-check.sh`, every half hour | The real thing on staging: the app passed before updates itself, Squirrel checks the signature and installs at quit, and the new app opens |

Only the macOS check proves Squirrel's signature check, ShipIt's install, and that a signed app opens. It runs only when
staging's desktop feed names an app it hasn't passed, and on staging alone.

### The staging update check

Before prod takes a new Mac app, staging's app of the same version must have updated itself to it on a Mac.
`.github/workflows/mac-update-check.yml` runs every half hour on one of GitHub's Macs, in the `release` environment
for the inbox role, with no signing secret, and by hand (`gh workflow run mac-update-check.yml`). A Linux job looks
first: a Mac is taken only when staging's desktop feed names an app the check hasn't passed, which it reads from the
artifact the last passing check wrote beside its pass, since the inbox role can't read the inbox. On the Mac,
`scripts/mac-update-check.sh` installs
the app it passed before from its folder on staging's downloads host, opens it, and waits for it to download and
stage the new one. Then it quits the app, as from the menu bar, waits for Squirrel to install the new app, checks that
the app didn't open again, and opens it to check it's the new version and starts. A pass goes to
`inbox/update-check/<app version>.json`. The app it passed is kept in the run's artifact, so the next run updates
from it. With no app passed before, as for the first app that updates itself, it checks only that the new app installs
and starts. It does the same when the app passed before has no `Contents/Resources/app-update.yml`, as every app from
before 17 November 2026 has none: electron-updater reads that file before it downloads, so those apps can't update
themselves, and updating from one would fail every run.

**Prod waits for it.** Prod's release publishes a new Mac app only once the inbox has its pass. Until then prod's
desktop feed stays as it is, and the run says so, as the iPhone feed does for TestFlight. That holds for a new app with
unchanged native code too, as when prod's downloads host served no checked app when the MacApp step looked: the
build's signed manifest names that app, and a feed must never name an app the downloads host doesn't have. The next run
that finds a checked app live names that one instead. A run that needs no new app doesn't wait. Staging gets each new
app a promote window ahead, which is time for the check to run.

### What the check proves

For each environment's upload, on Linux, with OpenSSL and 7-Zip:

- **It's the commit's it was taken as.** The manifest names the commit: the run's, or the earlier one with the same Mac
  native code that the step took. The disk image's and the zip's SHA-256s are the manifest's. The app's version is
  `0.1.<build>`, in the manifest, the app's `package.json` and its `Info.plist`, and the manifest's shell hash is the
  pipeline's build's, which the app's record carries into the release's manifest.
- **The configured team signed it, with a Developer ID.** The disk image's signature and the app's both verify: their
  code directories match every byte of the disk image, and of the app's executable, Info.plist and resource seal.
  OpenSSL checks each CMS signature. Its certificate must be a Developer ID Application certificate naming
  `pipeline.mac.teamId`, issued by Apple's Developer ID CA under Apple's root, which the check knows by their SHA-256
  fingerprints, and in date.
- **Apple notarized it.** Apple's public ticket lookup, which Gatekeeper uses, has a ticket for the disk image's
  cdhash and for the app's.
- **It runs the pipeline's own code.** `app.asar` holds exactly the web build (`dist`) and main process
  (`dist-electron`) the pipeline made from the commit, byte for byte: the Build step for the run's own, or the MacApp
  step for an earlier one, with no file more or less, and the app's
  resource seal covers that `app.asar`. Its `package.json` is the checkout's, as electron-builder trims it.
  better-sqlite3's JavaScript, unpacked beside it, is the installed package's. The web build and main process come
  out the same on macOS and Linux.
- **It runs Electron's own native code.** Every file in the app is Electron's, from its darwin-arm64 zip, which the
  check downloads and refuses unless it has the SHA-256 in the installed `electron` package's `checksums.json`, or one
  of the app's own: `app.asar` and what's unpacked beside it, the icon, `app-update.yml`, the resource seals and the
  stapled ticket. `app-update.yml` must be there, sealed, and name a generic feed at the environment's downloads host
  and a folder for downloads, or the app couldn't update itself. Each
  Mach-O binary must equal Electron's byte for byte once signed again: only its signature, the load command that
  points at it, and the `__LINKEDIT` sizes that follow from it are left out, and only after checking that's all
  signing changed. better-sqlite3's binaries must equal the installed package's the same way. Electron's fuses, which
  the comparison leaves out, must be exactly the ones `electron/identity.ts` sets, the rest as Electron ships them, so
  turning on `RunAsNode`, say, fails. Every `Info.plist` key is Electron's or what electron-builder writes for this app,
  `ElectronAsarIntegrity` the hash of this `app.asar`'s header. Anything else, such as a binary Electron hasn't got,
  fails.
- **The zip is the same app.** It's read as `ditto` would unpack it, from its central directory, each entry checked
  against its local header, refusing a name twice, an absolute or `..` path, or entries that overlap. It must hold the
  disk image's app exactly: the same paths, each a file, folder or link alike, links to the same places inside the app,
  and the same contents. Its modes must be Electron's for Electron's files, and plain for the app's own.

`rcodesign verify` isn't used: it reads only Mach-O binaries, not disk images or the resource seal that holds
`app.asar`, doesn't check the certificate chain, and warns that it "is known to be buggy and gives misleading results".

**What it can't catch:**

- **The blockmap.** It's copied, not checked: electron-updater uses it to fetch only the zip's changed blocks, then
  checks the whole zip's SHA-512 against the signed record.
- **Nested signatures.** The check verifies the disk image's signature, which covers every byte of it, and the app's
  executable's. The signatures inside the app, on its frameworks and helpers, are left to Apple's notarization.
- **A disk image made to read differently.** The app is read from the disk image with 7-Zip, not macOS. Only someone
  holding both keys could make an image that macOS reads differently, and Apple would have to notarize it.
- **Revocation after the fact.** It doesn't ask whether Apple has since revoked the certificate or a ticket.
- **The manifest's other fields.** The web version, Electron version and notary submission ids are for people reading
  it; only the commit, app version, shell hash and file hashes are checked.

### The release environment

The signing job, like the TestFlight workflows' jobs, runs in the GitHub environment `release`, which takes deployments
only from `main`, may need the owner's approval, and holds the only copies of the signing secrets:

| Name | Kind | Holds |
| --- | --- | --- |
| `MAC_CERT_P12` | Secret | The Developer ID Application certificate and its key, as a `.p12`, in base64 |
| `MAC_CERT_PASSWORD` | Secret | The `.p12`'s password |
| `ASC_API_KEY` | Secret | The App Store Connect API key that notarizes, the `.p8` file's contents |
| `ASC_KEY_ID` | Secret or variable | That key's id |
| `ASC_ISSUER_ID` | Secret or variable | Its issuer id |
| `MAC_BUILD_CONFIG` | Secret | What the Mac build reads from the config folder: each environment's backend addresses, attachment hosts, sign-in client, bundle id and release key's public half |
| `STAGING_TEST_TARGET` | Secret | Staging's API, test client and test user, password included, as `ENV=staging node frontend/scripts/test-target.mjs` prints it, for the nightly iPhone tests against staging (`ios-staging.yml`). Set it again if the test user's password in SSM changes |
| `AWS_INBOX_ROLE_ARN` | Secret or variable | The inbox role's ARN, from the pipeline stack's outputs |
| `AWS_INBOX_BUCKET` | Variable | The inbox bucket's name, from the same |
| `AWS_REGION` | Variable | The control account's region |

The key id, issuer id and role ARN work as either, but a variable's value is printed in the run's log, which anyone can
read on a public repository, and the role's ARN names the control account. Secrets are masked.

`STAGING_TEST_TARGET` comes from SSM, so set it from the Mac, signed in to AWS for staging and to `gh` as the owner, with
`MULTISCALE_CONFIG_DIR` set:

```sh
(cd frontend && ENV=staging node scripts/test-target.mjs) | gh secret set STAGING_TEST_TARGET --env release
```

The role, `multiscale-mac-inbox`, trusts only GitHub's OIDC tokens whose subject is
`repo:<owner>/<repo>:environment:release`, as `pipeline.repository` names the repository, letter case included, or the
subject in `pipeline.mac.githubSubject`. A repository with GitHub's immutable subjects gets tokens that also name its
owner's and its own ids, `repo:<owner>@<id>/<repo>@<id>:environment:release`, and the role refuses them until
`githubSubject` says so: `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` shows the prefix. It may
put objects under `inbox/` in the inbox bucket and do nothing else, for an hour at most; an infrastructure test checks
that. The bucket is private and encrypted, and forgets each upload after 30 days. Pull requests never run the workflow,
and a fork's runs stop before any job.

### Setting up the Mac release

Once, after `make release` has notarized a Mac app from your Mac ([setup, step 15](setup.md)). Run these on the Mac,
with `MULTISCALE_CONFIG_DIR` set and signed in to `gh` as the owner.

1. **The config.** In `control.yaml`, under `pipeline`, add `mac` with your team id, as `config/control.example.yaml`
   shows. If `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` shows `"use_immutable_subject": true`, add
   `githubSubject:` with its `sub_claim_prefix` followed by `:environment:release`. If the control account already has
   GitHub's OIDC provider, which this lists, add `githubOidcProvider: existing`:

   ```sh
   aws iam list-open-id-connect-providers --profile <control profile>
   ```

2. **The inbox.** `make deploy ENV=pipeline`, then `make pipeline-config`.
3. **The environment.** Only you approve, and only `main` deploys:

   ```sh
   repo=<owner>/<repo>
   gh api -X PUT "repos/$repo/environments/release" --input - <<EOF
   {"reviewers": [{"type": "User", "id": $(gh api user --jq .id)}], "prevent_self_review": false,
    "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
   EOF
   gh api -X POST "repos/$repo/environments/release/deployment-branch-policies" -f name=main -f type=branch
   ```

   `prevent_self_review` stays off, since the run you approve is the one your merge started.

   The reviewer is optional while you're the only one who can push to `main` or start workflows. Every commit there has
   then come through your merge, and a pull request from a fork never gets the environment's secrets. With
   `"reviewers": []`, a run from `main` starts at once. Add the reviewer back before anyone else gets write access. The
   TestFlight workflows' jobs run in the environment too, each push's and the review's every hour, so with a reviewer
   each of those waits for approval as well.
4. **The Developer ID.** In **Keychain Access**, under **login > My Certificates**, select
   **Developer ID Application: …** with its key, choose **File > Export Items**, and save it as `DeveloperID.p12` with
   a new password. Then, typing that password when asked:

   ```sh
   base64 -i DeveloperID.p12 | gh secret set MAC_CERT_P12 --env release --repo "$repo"
   gh secret set MAC_CERT_PASSWORD --env release --repo "$repo"
   rm DeveloperID.p12
   ```

5. **The notary key,** from the config folder:

   ```sh
   key="$(ls "$MULTISCALE_CONFIG_DIR"/AuthKey_*.p8)"
   key_id="$(basename "$key" .p8)" && key_id="${key_id#AuthKey_}"
   gh secret set ASC_API_KEY --env release --repo "$repo" <"$key"
   gh secret set ASC_KEY_ID --env release --repo "$repo" --body "$key_id"
   gh secret set ASC_ISSUER_ID --env release --repo "$repo" <"$MULTISCALE_CONFIG_DIR/asc-issuer-id"
   ```

6. **The build's config.** Again whenever a backend address, the sign-in client, the bundle id or a release key
   changes, and when attachments are turned on, which adds their hosts. Until then the check fails, saying the build's settings differ:

   ```sh
   (cd frontend && node scripts/mac-inbox.ts build-config "$MULTISCALE_CONFIG_DIR") | gh secret set MAC_BUILD_CONFIG --env release --repo "$repo"
   ```

7. **The inbox's address,** from the pipeline stack:

   ```sh
   output() { aws cloudformation describe-stacks --stack-name Multiscale-pipeline --profile <control profile> --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
   gh secret set AWS_INBOX_ROLE_ARN --env release --repo "$repo" --body "$(output MacInboxRoleArn)"
   gh variable set AWS_INBOX_BUCKET --env release --repo "$repo" --body "$(output MacInboxBucket)"
   gh variable set AWS_REGION --env release --repo "$repo" --body <control region>
   ```

8. **A first build.** `gh workflow run mac-release.yml -f commit="$(git rev-parse origin/main)"`, then, if the
   environment has a reviewer, approve it under the run's **Review deployments**. It stops at once, naming anything
   missing from the environment.

### When a run stops for the Mac app

- **No Mac app in time.** The MacApp step's log says which commit. Approve the workflow run if it waits for you, or
  start one for that commit with `gh workflow run mac-release.yml -f commit=<sha>`, and once it has uploaded, retry the
  Staging stage, which its log prints the command for (`aws codepipeline retry-stage-execution ... --retry-mode
  FAILED_ACTIONS`), or run the pipeline again: `make promote COMMIT=<sha>`. GitHub's macOS runners are shared with the
  PRs' iPhone job, so a Mac build can queue for a while when many PRs are open. Every push to main starts a build, and
  a newer push drops the one queued, so a run waits only when no commit since the Mac native code last changed has a
  finished build: the one building may still arrive, or have failed, and its run's log says which. A commit before
  this one whose build the step left, because the pipeline's own build of it has other native code, is named in the
  step's log.
- **The check failed.** The MacApp step's log lists every problem. Nothing was published. "The build's settings
  differ" means `MAC_BUILD_CONFIG` is out of date: make it again (step 6 above) and build again.

## iPhone apps from TestFlight

A commit that changes the iPhone app's native code, such as a Capacitor plugin, its version, or anything under
`frontend/ios`, needs a new iPhone app before installed apps can take its bundle. Testers get the app from TestFlight,
so GitHub Actions uploads one, Beta App Review passes it, and the pipeline then switches the iPhone feed. A TestFlight
build is a prod build, numbered by its commit's time, and its native code is named by the iPhone app's shell hash
(`frontend/scripts/shell-hash.ts`), as each bundle's is.

1. **GitHub Actions uploads it.** `.github/workflows/testflight.yml` runs for every push to main. A first job, on
   Linux so that most pushes hold none of the Macs CI's iPhone job shares, asks App Store Connect for TestFlight's latest
   build, finds the main commit with its number, and hashes that commit's native code with that commit's own
   `shell-hash.ts`. Only when this commit's differs does a Mac build the app and upload it, as
   [setup.md](setup.md#testflight-from-github-actions) describes, and submit it for Beta App Review. A build uploaded
   any other way counts the same, whether from the workflow by hand or with `make testflight` on a Mac. Uploads go one
   at a time, and a push's upload that waited for another asks again first, so two pushes with the same new native code
   upload once. By hand it always uploads: `gh workflow run testflight.yml --ref main [-f commit=<full commit hash>]`.
2. **The TestFlight review records what testers can install.** `.github/workflows/testflight-review.yml` runs every
   hour on Linux. It asks App Store Connect for the newest build in the **Testers** group that Beta App Review has
   passed, so that it's in beta testing, and that hasn't expired. That's the build TestFlight offers testers. It hashes
   its commit's native code the same way, and writes `inbox/testflight/latest.json` to the pipeline's inbox: the build,
   its commit and its shell hash, or nulls when testers have no build or no main commit has its number, as for one
   uploaded from a branch. It writes it every hour, so the record is never more than an hour old.
3. **The releases switch the iPhone feed.** Staging's and prod's releases read that record. When a build needs other
   iPhone native code than the iPhone feed serves, the feed takes it only if the record names that native code.
   Otherwise it stays as it is, and the release says so. Only the newest build counts: an older one with this native
   code may still be out, but testers are offered the newest.

**A run doesn't wait for Beta App Review.** Apple can take a day, and a CodeBuild step can't wait more than about 40
minutes, so waiting would stop the run, holding up the web app and the backend. Instead each release checks the record
as it publishes: staging's when it reaches staging, and prod's hours later, so prod can switch the iPhone feed in a run
whose staging release didn't. Otherwise the first run after Beta App Review passes the build switches it, with that
run's own build. Main moves most days; `make promote` starts a run sooner.

**What it trusts.** The record is GitHub's word: the pipeline never gets the App Store Connect key, so it can't ask Apple
itself, as it checks a Mac app. Only a job in the `release` environment may write to the inbox. A wrong record could at
worst switch the feed early, and then an installed app still checks each bundle's native code against its own and
skips one it can't run, saying it needs a new version of the app (`frontend/src/core/updates.ts`).

**Staging** reads the same record, since there's no staging TestFlight build, so its switch rehearses prod's. An iPhone
app built for staging comes from Xcode: run it from Xcode again.

### What's new

The first time an update with something new runs on an iPhone, the app shows a sheet titled "Multiscale has been
updated". Under "What's new" and the date of the update, such as Nov 24, it has a one-sentence line for each change,
never a version or a commit. Each phone shows each line once.

- **The lines** are in [`frontend/src/whatsNew.ts`](../frontend/src/whatsNew.ts), newest first. A pull request that
  changes what someone can do on the iPhone adds its line at the top, with the next id. One plain sentence in the app's
  voice: sentence case, what the person can now do, no jargon, no pull request numbers. Ids are never reused or
  changed, and `core/whatsNew.test.ts` checks the rules. A line ships with the bundle, so it reaches a phone with the
  change it describes, whether over the air or in a new TestFlight app.
- **When it shows.** Each launch, and each switch to a downloaded bundle, which reloads the page, compares the newest
  line in the running bundle with the newest this phone has seen, kept in the web view's local storage and never synced.
  It shows the newer lines together, at most six, once the app is idle on a screen: never during setup, a flow such as
  planning, Capture, Process, a prompt or another sheet. Got it, Esc, the backdrop or a swipe down puts it away and
  records the newest line as seen.
- **A new install** records every line as seen during first-run setup, and shows none. A phone that ran the app before
  What's new existed has recorded none, so it shows the newest lines once. The UI tests' Erase records them as a new
  install would, since their seeds skip setup.
- **The date** is the running bundle's build, its commit's time (`build` in `version.json`), as a day in the phone's
  time zone, such as Nov 24. A commit reaches staging within the hour and prod after its canary, usually the same day.
- **Only the iPhone, for now.** The Mac app and the web app don't show it. `e2e/whats-new.spec.ts` checks it at phone
  size in the browser, which stands in for the iPhone in dev builds only.

### Setting up TestFlight from GitHub Actions

Once, after [Setting up the Mac release](#setting-up-the-mac-release), whose inbox and environment it shares, and
[TestFlight from GitHub Actions](setup.md#testflight-from-github-actions), whose secrets it reads:

1. **The releases' inbox.** `make deploy ENV=pipeline`, which names the inbox to the releases. Until then they never
   switch the iPhone feed for a new native code.
2. **A first record.** `gh workflow run testflight-review.yml`, or wait for the hour. Its log says which build testers
   can install and its native code.

### When the iPhone feed waits

- **No build with the new native code yet.** The TestFlight workflow's run for the commit that changed it says whether
  it uploaded, and the TestFlight review's last run which build testers can install. Beta App Review usually takes a
  few hours, and a later build of the same version often passes at once.
- **Apple refused or rejected the build.** A push with the same native code doesn't upload again. Fix what Apple said,
  or for a passing reason, upload by hand: `gh workflow run testflight.yml --ref main`.
- **The record has no native code.** The newest build came from a commit that isn't on main. Upload one from main.

## The release keys

The apps install only bundles signed with their environment's release key. On the Mac it is `<env>.release-key.pem` in
the config folder, made by the first `make release`. Keep it backed up.

The pipeline signs with a copy in SSM in the control account: the SecureString
`/multiscale/pipeline/signing/<env>.release-key.pem`, encrypted with the KMS key `alias/multiscale-release-signing`.
Only the signing step may read it:

- **The signing step has its own CodeBuild project and role,** `multiscale-pipeline-signer`. That role may read only
  the two key parameters and decrypt with only their KMS key, besides reading and writing its artifacts. No other
  role in the pipeline may do either, and an infrastructure test checks that.
- **It runs as little as it can.** It installs nothing. It runs `sign-release.mjs`, which uses Node's standard library
  alone, on the image's own Node, over the web builds in the tested Build output. The script comes from this commit's
  checkout rather than the Build output, which the build's npm packages could rewrite. CodeBuild hands it the key in an
  environment variable and keeps it out of the log. Its output, the feed's `release.json` and files, is all the
  publishing step gets.
- **The steps that build, deploy and test never see a key.** The web build only needs a key's public half, uploaded as
  `/multiscale/pipeline/config/<env>.release-key.pub`.

**Every read is in CloudTrail.** CloudTrail records each read of a key in the control account: the `GetParameters` call
when the signing step starts, and the KMS `Decrypt` that goes with it. CloudTrail's event history keeps them for 90 days.
Any principal there but the signer role is worth looking into. So is a read when no release was running.

**Rotating a key.** The apps check updates against the key their own build carries, so a new key reaches a device only
with a new Mac or iPhone app:

1. On the Mac, move `<env>.release-key.pem` out of the config folder, keeping it.
2. Run `make release ENV=<env>`. It makes a new key, builds the Mac app carrying its public half, and publishes the app
   and a feed signed with it. Apps already installed won't take that feed: each keeps its bundle until it gets the new
   app, from the downloads page on the Mac and from Xcode or TestFlight on the iPhone.
3. Run `make pipeline-config`. It replaces the key in SSM, deleting the old parameter first so its history keeps no copy,
   and replaces the public half.
4. Back up the new key. Destroy the old one once every device runs the new app.

If a key may have leaked, rotate it at once. A leaked key can still sign updates that apps carrying it will install, so
install the new app on every device.

## Costs

| | A month |
| --- | --- |
| CodeDeploy for Lambda | $0 |
| CodePipeline V2, and CodeBuild for releases | About $1–3 |
| Two KMS keys: the artifacts', which prod's account reads them with, and the release keys' | $2 |
| Ten or so more CloudWatch alarms | About $1 |
| The release canary, about 8,600 short Lambda runs | Under $0.10 |
| The window before prod, a three-state Step Functions run each release, and its link's Lambda | Under $0.01 |
| The nightly suites, about 90 small build minutes on each day main moved, half of it the retention suite's build | About $0.45 a night |
| The Mac app's check, a small build that waits for GitHub's build, only for a run that needs a new Mac app | Up to $0.60 a time, for a two-hour wait |
| The Mac release's inbox, two disk images a time, kept 30 days | Under $0.05 |
| The TestFlight review's record, written to the inbox every hour, on GitHub's runners, which a public repository doesn't pay for | Under $0.01 |
