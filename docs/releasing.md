# Releasing

Every change reaches prod the same way: green CI before it merges to main, then a pipeline that builds that main
commit once, deploys it to staging and tests it there, emails that it passed, and after a window in which the owner
can stop it, promotes the same build to prod. No one needs to approve it. Prod's backend then takes the new version by
canary: 10% of traffic for 90 minutes, with alarms that move it back on their own. The signed Mac and iPhone apps stay a
step on the Mac.

The pipeline is AWS CodePipeline and CodeBuild in the control account (`infrastructure/lib/pipeline-stack.ts`), and its
steps are `scripts/pipeline.sh`. Deploy rights stay in AWS: GitHub's CI holds no AWS credentials.

## The flow

| Stage | Runs against | What happens | Stops the release when |
| --- | --- | --- | --- |
| **Pull request** | Nothing deployed: the local stack and the iOS Simulator, in GitHub's CI | Unit tests, Go, infrastructure, browser e2e at desktop and phone sizes, the Mac app, the local stack, cross-version, iOS | A check fails. Every check must pass before a merge |
| **Build** | Nothing | Builds the Lambdas once and synthesizes staging's and prod's stacks from them. Builds each environment's web app from the same commit | A build or config check fails |
| **Staging** | Staging | Deploys the backend, which takes traffic by staging's canary, 5% for 10 minutes. Signs staging's feed in the signing step. Publishes the web app and the feed, then runs the web app, sync, cross-version, integration and smoke suites | A suite fails, or a release alarm rolls the canary back |
| **Promote** | Nothing | An email: the commit passed staging and goes to prod at a time it gives, unless the owner stops it. Then a wait until that time, two hours unless `control.yaml`'s `pipeline.promoteAfter` says otherwise | `make pipeline-stop` during the window |
| **Prod** | Prod | Deploys the backend by prod's canary, 10% for 90 minutes. Runs the web app, integration and smoke suites against the apps people already have. Then signs prod's feed in the signing step, publishes the web app and the feed, and checks them | A release alarm rolls the canary back, or a suite fails |
| **Nightly** | Staging | The full deployed suite with retention and the history-scale test, so slow suites never hold up a release. Runs only when main has moved | Nothing. A failure is emailed |
| **On the Mac** | Prod | `make release-tag`, then the signed Mac and iPhone builds from that tag | — |

Two suites stay off prod on purpose. Sync, because prod's sign-in only returns to the deployed app. The 4.5 MB load test,
because it sets off prod's throttle alarm. The iPhone's signed-in test needs a Mac, so it runs there: `make test-ios`,
or `make test-deployed`.

The history-scale budgets only report for now (`HISTORY_REPORT_ONLY=1`). A missed budget never stops a release.

Each web build carries its environment's backend addresses, from its stack's outputs as Build finds them. A release
that changes one of those outputs, such as a new sign-in client, reaches the web app with the run after it.

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
- **The web app and the feed:** release the commit before the bad one: `make promote COMMIT=<sha>`. The apps keep
  the bundle they have until a newer one is published.

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

**The signed apps.** After a release reaches prod, run `make release-tag`, then `git checkout <tag>` and `make release
ENV=prod`. That builds and signs the Mac app on the Mac and uploads it, then the feed. When a release changes native
code, the pipeline leaves the feed alone and says so, since the apps couldn't take it yet. The Mac's release then
uploads the new app first and the feed after.

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
