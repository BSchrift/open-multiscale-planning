# Releasing

Every change reaches prod the same way: green CI before it merges to main, then a pipeline that builds that main
commit once, deploys it to staging and tests it there, emails that it passed, and after a window in which the owner
can stop it, promotes the same build to prod. No one needs to approve it. Prod's backend then takes the new version by
canary: 10% of traffic for 90 minutes, with alarms that move it back on their own. A commit that changes the Mac app's native
code gets a new Mac app from GitHub Actions, which the pipeline checks and publishes, once
[set up](#mac-apps-from-github-actions). The signed iPhone app stays a step on the Mac.

The pipeline is AWS CodePipeline and CodeBuild in the control account (`infrastructure/lib/pipeline-stack.ts`), and its
steps are `scripts/pipeline.sh`. Deploy rights stay in AWS: GitHub's CI holds no AWS credentials. The one exception is
the Mac release's, which may only upload to the pipeline's inbox, through GitHub's OIDC token, with no long-lived key.

## The flow

| Stage | Runs against | What happens | Stops the release when |
| --- | --- | --- | --- |
| **Pull request** | Nothing deployed: the local stack and the iOS Simulator, in GitHub's CI | Unit tests, Go, infrastructure, browser e2e at desktop and phone sizes, the Mac app, the local stack, cross-version, iOS | A check fails. Every check must pass before a merge |
| **Mac release** | Nothing: GitHub Actions on macOS, once the owner approves | For a main commit that changes the Mac app's native code, builds, signs and notarizes the staging and prod Mac apps, and uploads them to the pipeline's inbox | The owner doesn't approve it, or a build or notarization fails. The pipeline then stops at Staging |
| **Build** | Nothing | Builds the Lambdas once and synthesizes staging's and prod's stacks from them. Builds each environment's web app and Mac main process from the same commit | A build or config check fails |
| **Staging** | Staging | Deploys the backend, which takes traffic by staging's canary, 5% for 10 minutes. Beside it, when the build needs a new Mac app, waits for GitHub's and checks it. Signs staging's feed in the signing step. Uploads the [version](#versions-and-feeds), then switches the web app, publishes any new Mac app, switches each feed that can take the build, and runs the web app, feed, sync, cross-version, integration and smoke suites | A suite fails, a release alarm rolls the canary back, or a needed Mac app doesn't arrive or fails its checks |
| **Promote** | Nothing | An email: the commit passed staging and goes to prod at a time it gives, unless the owner stops it. Then a wait until that time, two hours unless `control.yaml`'s `pipeline.promoteAfter` says otherwise | `make pipeline-stop` during the window |
| **Prod** | Prod | Deploys the backend by prod's canary, 10% for 90 minutes. Runs the web app, integration and smoke suites against the apps people already have. Then signs prod's feed in the signing step, uploads the version and switches the web app, any new Mac app the Staging stage checked, and each feed that can take the build, and checks them | A release alarm rolls the canary back, or a suite fails |
| **Nightly** | Staging | Each surface switched back one version and forward again, read back from its host. Then the full deployed suite with retention and the history-scale test, so slow suites never hold up a release. Runs only when main has moved | Nothing. A failure is emailed |
| **On the Mac** | Prod | `make release-tag`, then the signed iPhone build from that tag, and the Mac app's too until the Mac release is set up | — |

Two suites stay off prod on purpose. Sync, because prod's sign-in only returns to the deployed app. The 4.5 MB load test,
because it sets off prod's throttle alarm. The iPhone's signed-in test needs a Mac, so it runs there: `make test-ios`,
or `make test-deployed`.

The history-scale budgets only report for now (`HISTORY_REPORT_ONLY=1`). A missed budget never stops a release.

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
| `release/release.json` | The shared feed, which bundles from before the apps' own feeds read | Release host |
| `state/history.json` | Each surface's versions in the order it got them, with times | No |

A version is what its `version.json` names: the package version and the commit, such as `0.1.0-85e85c2`. Switching web
copies its page to `web/` with `no-cache`, `version.json` last, so the next page load gets it. Switching a feed copies
its `release.json`, and each device takes it at its next check.

A feed takes a build only when its app can. The desktop feed compares the Mac app's native code with what it serves,
and takes the build when it's unchanged or a Mac app from GitHub Actions is published first. The iPhone feed compares
the iPhone app's. The shared feed takes the build only when both do. Until an app's own feed exists, it compares with
the shared one. Each release checks every feed it switched: the manifest checks out with the environment's release
key, names the version, and lists only files that download with their SHA-256 (`frontend/e2e/deployed/feed.spec.ts`).

For now every surface switches in one step, staging's and prod's Release, and bundles still read the shared feed.

## The backend canary

Each Lambda (the API, the calendar worker, retention) has a `live` alias, and everything that invokes one goes through
it. A deploy that changes a Lambda publishes a new version, and CodeDeploy moves the alias to it in steps:

1. **Before any traffic,** for the API, the release canary (`cmd/canary`) calls the new version directly. That is a sync
   round trip as a made-up user of its own. If it fails, the deploy stops with nothing shifted.
2. **A share of traffic for a while:** prod sends 10% of invocations to the new version for 90 minutes, and staging 5%
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

With one real user, 10% of 90 minutes' requests is a handful and might miss what breaks. So a schedule also runs the
release canary every 5 minutes against the alias. That is about 18 runs in a canary, about 2 of them on the new
version at 10%, after the check before traffic has already run it once. One failed run is enough to roll back.

**What a canary can't cover.** It splits traffic between two versions of code. Everything else lands all at once: table,
index, stream and TTL settings, IAM, schedules, and the config files the Lambdas read. Those follow the compatibility
rules in AGENTS.md, and a risky one ships as its own release, ahead of the code that needs it.

**The web app and the feed** aren't split by traffic. They are published only after the backend has all its traffic,
and each device's 20-second trial and rollback protects it from a bundle that won't start.

## Skipping the canary

`make promote CANARY=skip` starts a run that sends prod's new backend all its traffic at once, rather than 10% for 90 minutes.
It still deploys and tests staging first, still waits out the window before prod, and keeps prod's check before traffic, the alarms,
the automatic rollback and the suites. Use it for:

- a fix that can't wait 90 minutes;
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
- **After promotion:** revert the bad commit on main and let it release. A fix that can't wait 90 minutes can skip
  the canary.
- **The web app, or one app's feed:** switch it back to a version kept, as below.

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

A feed switch only stops a bad version spreading, because the apps never take an older bundle than the one they have:
the page skips a release whose build isn't newer (`frontend/src/core/updates.ts`), and the Mac and iPhone install only
a newer bundle and always run the newest they have. A device that already took the bad one keeps it, unless it failed
its 20-second trial, which rolls it back on that device by itself. A revert on main is a newer build with the old code.

It refuses a version that isn't kept, and, for a feed, a version built for other native code than the apps that feed
serves, since they couldn't take it. Web has no such guard: a browser loads whatever page is live. The compatibility
test checks the bundle a release replaces against the new one, so going back one version is tested. Going back further
is the owner's call, and the command says so.

While bundles from before the per-app feeds are about, `SURFACE=shared` switches the shared feed they read, with both
apps' native code checked.

Every night, staging's run switches the web app and each app's feed back one version and forward again with the same
code, and reads each back from its host.

When a release alarm is already firing as a deploy starts, CodeDeploy refuses the deploy, and CloudFormation rolls it
back. To ship the fix for it, see [Shipping while a release alarm fires](#shipping-while-a-release-alarm-fires).

## Steering it

All of these run on the Mac, signed in with `control.yaml`'s profile:

| Command | Does |
| --- | --- |
| `make pipeline-pause` | Main commits stop at Build: each run they start stops itself. The switch is the SSM parameter `/multiscale/pipeline/paused` |
| `make pipeline-resume` | Each main commit releases to staging again |
| `make pipeline-stop` | Stops the run waiting in its window before prod, abandoning it, and says which commit it stopped. Staging keeps that commit; prod never gets it |
| `make promote` | Starts a run by hand, which the pause lets through. `COMMIT=<sha>` picks the commit (default: the branch's latest). `CANARY=skip` and `ALARMS=off` are above |
| `make release-surface` | Lists what each surface serves and the versions kept, or switches one surface to a version kept: [One surface at a time](#one-surface-at-a-time) |
| `make release-tag` | Tags the commit prod last released as `release-<date>`, noting a skipped canary or the alarms off, and pushes the tag |
| `make pipeline-config` | Uploads the config folder's files the pipeline reads: `control.yaml`, `staging.yaml`, `prod.yaml`, and each release key's public half. Each key itself goes where only the signing step reads it |
| `make deploy ENV=pipeline` | Deploys the pipeline itself |

**Promotion needs no approval.** When staging passes, a state machine (Step Functions, so the wait costs no build
minutes) emails the commit and the time it goes to prod, then waits until that time. To keep it from prod, run `make
pipeline-stop`, or choose **Stop execution** on the run in CodePipeline, before then. **An agent stops a run only when the
owner asks in chat.** The window is `pipeline.promoteAfter` in `control.yaml`, an ISO 8601 duration of whole days, hours,
minutes and seconds up to 6 days: `PT2H` when it's left out, `PT0S` to go at once. Prod's canary and its alarms still
guard the release. Failed runs and failed nightly runs are emailed to the same address. The pause switch is unchanged:
it holds back new runs, not one already past staging.

**The signed apps.** Each build names the native code it needs, and the pipeline compares that with the feed's. When
the Mac app's changed, the pipeline publishes the Mac app GitHub Actions built and checked, then the feed, so an
older app that can't take the new bundle is offered the new app instead
([Mac apps from GitHub Actions](#mac-apps-from-github-actions)). When the iPhone app's changed, or the Mac app's
without the Mac release set up, the pipeline leaves the feed alone and says so. Then, after the release reaches prod,
run `make release-tag`, then `git checkout <tag>` and `make release ENV=prod`. That builds and signs the Mac app on the
Mac and uploads it, then the feed. Once its tests pass, it uploads the iPhone app from the same commit to TestFlight,
so testers' builds take the same updates; `SKIP_TESTFLIGHT=1` leaves that out, and GitHub Actions can upload it instead,
as [setup.md](setup.md#testflight) explains.

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
backend addresses the app allows, needs a new Mac app before installed apps can take its bundle. GitHub Actions builds
it, since signing and notarizing need macOS, and the pipeline checks it on Linux before publishing it. The pipeline
never trusts GitHub's word for any of it.

1. **GitHub Actions builds it.** `.github/workflows/mac-release.yml` runs for a push to main that changes what the Mac
   app's shell hash covers (`frontend/scripts/shell-hash.ts`), or by hand for a main commit:
   `gh workflow run mac-release.yml -f commit=<full commit hash>`. A first job, with no secrets, checks that the commit
   is on main and that its native code really changed. The signing job then waits for the owner's approval in the
   `release` environment. It installs the lockfile's packages with no install scripts, imports the Developer ID into a
   keychain of its own, builds the staging and prod apps with `scripts/mac-app.sh` (signed, notarized, stapled, opened
   by `spctl` and started, as `make release` does), and writes a manifest beside each disk image: the commit, the
   versions, the shell hash, SHA-256s and the notary submissions. It uploads both to
   `s3://<inbox bucket>/inbox/<commit>/<env>/`, the manifest last, and deletes the keychain and the notary key.
2. **The pipeline waits for it.** The Staging stage's MacApp step, beside staging's deploy, compares each
   environment's feed with this build. For each that needs a new Mac app, it waits for that environment's manifest in
   the inbox, up to `pipeline.mac.waitFor` (two hours unless `control.yaml` says), then checks the upload
   (`frontend/scripts/mac-inbox.ts verify`). If nothing arrives in time, or the check fails, the run stops before
   anything is published, and before prod.
3. **The releases publish it.** Staging's and prod's releases upload the checked disk image to
   `downloads.<zone>/Multiscale.dmg`, then the feed, as `make release` does. An environment whose feed can take the
   build as its Mac app is gets no new Mac app, and nothing changes. A build that also needs a new iPhone app still
   leaves the feed for a release from the Mac.

### What the check proves

For each environment's upload, on Linux, with OpenSSL and 7-Zip:

- **It's this commit's.** The manifest names the run's commit, and the disk image's SHA-256 is the manifest's.
- **The configured team signed it, with a Developer ID.** The disk image's signature and the app's both verify: their
  code directories match every byte of the disk image, and of the app's executable, Info.plist and resource seal.
  OpenSSL checks each CMS signature. Its certificate must be a Developer ID Application certificate naming
  `pipeline.mac.teamId`, issued by Apple's Developer ID CA under Apple's root, which the check knows by their SHA-256
  fingerprints, and in date.
- **Apple notarized it.** Apple's public ticket lookup, which Gatekeeper uses, has a ticket for the disk image's
  cdhash and for the app's.
- **It runs the pipeline's own code.** `app.asar` holds exactly the web build (`dist`) and main process
  (`dist-electron`) the Build step made from the commit, byte for byte, with no file more or less, and the app's
  resource seal covers that `app.asar`. Its `package.json` is the checkout's, as electron-builder trims it.
  better-sqlite3's JavaScript, unpacked beside it, is the installed package's. The web build and main process come
  out the same on macOS and Linux.

`rcodesign verify` isn't used: it reads only Mach-O binaries, not disk images or the resource seal that holds
`app.asar`, doesn't check the certificate chain, and warns that it "is known to be buggy and gives misleading results".

**What it can't catch:**

- **Native code.** Electron's framework and helpers and better-sqlite3's prebuilt binary are signed and notarized, but
  compared with nothing, since signing changes them. A signing job that was tampered with, or someone holding both the
  Developer ID and the App Store Connect key, could change them and pass.
- **Nested signatures.** The check verifies the disk image's signature, which covers every byte of it, and the app's
  executable's. The signatures inside the app, on its frameworks and helpers, are left to Apple's notarization.
- **A disk image made to read differently.** The app is read from the disk image with 7-Zip, not macOS. Only someone
  holding both keys could make an image that macOS reads differently, and Apple would have to notarize it.
- **Revocation after the fact.** It doesn't ask whether Apple has since revoked the certificate or a ticket.
- **The manifest's other fields.** The versions, shell hash and notary submission ids are for people reading it; only
  the commit and hashes are checked.

### The release environment

The signing job runs in the GitHub environment `release`, which needs the owner's approval, takes deployments only from
`main`, and holds the only copies of the signing secrets:

| Name | Kind | Holds |
| --- | --- | --- |
| `MAC_CERT_P12` | Secret | The Developer ID Application certificate and its key, as a `.p12`, in base64 |
| `MAC_CERT_PASSWORD` | Secret | The `.p12`'s password |
| `ASC_API_KEY` | Secret | The App Store Connect API key that notarizes, the `.p8` file's contents |
| `ASC_KEY_ID` | Secret or variable | That key's id |
| `ASC_ISSUER_ID` | Secret or variable | Its issuer id |
| `MAC_BUILD_CONFIG` | Secret | What the Mac build reads from the config folder: each environment's backend addresses, sign-in client, bundle id and release key's public half |
| `AWS_INBOX_ROLE_ARN` | Secret or variable | The inbox role's ARN, from the pipeline stack's outputs |
| `AWS_INBOX_BUCKET` | Variable | The inbox bucket's name, from the same |
| `AWS_REGION` | Variable | The control account's region |

The key id, issuer id and role ARN work as either, but a variable's value is printed in the run's log, which anyone can
read on a public repository, and the role's ARN names the control account. Secrets are masked.

The role, `multiscale-mac-inbox`, trusts only GitHub's OIDC tokens whose subject is
`repo:<owner>/<repo>:environment:release`, as `pipeline.repository` names the repository, letter case included. It may
put objects under `inbox/` in the inbox bucket and do nothing else, for an hour at most; an infrastructure test checks
that. The bucket is private and encrypted, and forgets each upload after 30 days. Pull requests never run the workflow,
and a fork's runs stop before any job.

### Setting up the Mac release

Once, after `make release` has notarized a Mac app from your Mac ([setup, step 15](setup.md)). Run these on the Mac,
with `MULTISCALE_CONFIG_DIR` set and signed in to `gh` as the owner.

1. **The config.** In `control.yaml`, under `pipeline`, add `mac` with your team id, as `config/control.example.yaml`
   shows. If the control account already has GitHub's OIDC provider, which this lists, add
   `githubOidcProvider: existing`:

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
   changes. Until then the check fails, saying the build's settings differ:

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

8. **A first build.** `gh workflow run mac-release.yml -f commit="$(git rev-parse origin/main)"`, then approve it under
   the run's **Review deployments**. It stops at once, naming anything missing from the environment.

### When a run stops for the Mac app

- **No Mac app in time.** The MacApp step's log says which commit. Approve the waiting workflow run, or start one for
  that commit with `gh workflow run mac-release.yml -f commit=<sha>`, and once it has uploaded, run the pipeline again:
  `make promote COMMIT=<sha>`. A push whose native code didn't change starts no build, so a run for it can need one
  when the feed is older still, such as after a failed run.
- **The check failed.** The MacApp step's log lists every problem. Nothing was published. "The build's settings
  differ" means `MAC_BUILD_CONFIG` is out of date: make it again (step 6 above) and build again.

## The release keys

The apps install only bundles signed with their environment's release key. On the Mac it is `<env>.release-key.pem` in
the config folder, made by the first `make release`. Keep it backed up.

The pipeline signs with a copy in SSM in the control account: the SecureString
`/multiscale/pipeline/signing/<env>.release-key.pem`, encrypted with the KMS key `alias/multiscale-release-signing`.
Only the signing step may read it:

- **The signing step has its own CodeBuild project and role,** `multiscale-pipeline-signer`. That role may read only
  the two key parameters and decrypt with only their KMS key, besides reading and writing its artifacts. No other
  role in the pipeline may do either, and an infrastructure test checks that.
- **It runs as little as it can.** It installs nothing, and checks out nothing. It runs `sign-release.mjs`, which uses
  Node's standard library alone, on the image's own Node. The script comes from the tested Build output, beside the web
  builds it signs. CodeBuild hands it the key in an environment variable and keeps it out of the log. Its output, the
  feed's `release.json` and files, is all the publishing step gets.
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
| The window before prod, a two-state Step Functions run each release | Under $0.01 |
| The nightly suites, about 90 small build minutes on each day main moved, half of it the retention suite | About $0.45 a night |
| The Mac app's check, a small build that waits for GitHub's build, only for a commit that changes native code | Up to $0.60 a time, for a two-hour wait |
| The Mac release's inbox, two disk images a time, kept 30 days | Under $0.05 |
