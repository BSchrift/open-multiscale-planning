# Setup

Everything from a new AWS account to the app on your phone, in order. Each deployment is your own: your AWS accounts, your Google OAuth client, your Apple team. Your identifiers go only in your own config folder, outside this repo, starting from the committed `config/*.example.yaml` files.

Run every command from the repo root in zsh, the macOS default, unless a step says otherwise. Expect about two hours, most of it waiting on consoles.

Two environments exist, `staging` and `prod`. Each has its own AWS account, table, Cognito pool, secrets, schedule, alarms, Google client and app build. A third account, `control`, manages the other two and holds your domain if you have one. Do everything on staging first.

## 1. Tools

- Node 25 and Go 1.25.
- Xcode 16 or later, for iPhone.
- Docker, only for the local test suite.
- Git, for your config folder.
- AWS CLI v2, which `make deploy` also uses. **Update it first** if `aws --version` shows anything older than 2.20 or `exe/x86_64` on an Apple silicon Mac. Old versions can't read the `sso-session` profiles created in step 2, and x86 builds need Rosetta.

  ```sh
  curl -o /tmp/AWSCLIV2.pkg https://awscli.amazonaws.com/AWSCLIV2.pkg
  sudo installer -pkg /tmp/AWSCLIV2.pkg -target /
  aws --version
  ```

CDK is a local dev dependency, so don't install it globally.

## 2. AWS accounts and credentials

Three accounts, all under one AWS Organizations organization: `multiscale-control` is the management account, and `multiscale-staging` and `multiscale-prod` are member accounts created from it. You sign in to all three as one user.

1. Create an account at <https://aws.amazon.com> and name it `multiscale-control`. Turn on MFA for the root user, then stop using root. Do the rest of this step in this account.
2. Open **AWS Organizations** and choose **Create an organization**.
3. Choose **Add an AWS account > Create an AWS account**. Name it `multiscale-staging` and give it an email no other AWS account uses, such as `you+multiscale-staging@example.com` if your provider supports `+`. Leave the role name as it is. Do the same for `multiscale-prod`. Each takes a few minutes to appear.
4. Switch the console region to **US West (Oregon)**, open **IAM Identity Center** and choose **Enable**.
5. Under **Users**, add yourself. Accept the emailed invitation and set a password and MFA.
6. Under **Permission sets**, create a predefined one using **AdministratorAccess**.
7. Under **AWS accounts**, select all three accounts, choose **Assign users or groups**, and assign your user with that permission set.
8. Copy the **AWS access portal URL** from the Identity Center dashboard.
9. Make one CLI profile per account. Run `aws configure sso` three times: `multiscale` as the session name, that URL as the start URL, `us-west-2` as the region, then pick the account and name the profile after it.

   ```sh
   aws configure sso   # multiscale-control
   aws configure sso   # multiscale-staging
   aws configure sso   # multiscale-prod
   for p in multiscale-control multiscale-staging multiscale-prod; do
     aws sts get-caller-identity --profile $p --query Account --output text
   done
   ```

   Note each profile's 12-digit account id. When the session expires, run `aws sso login --sso-session multiscale`.
10. In the organization's management account, open **Billing and Cost Management > Budgets** and create a budget, for example a monthly cost budget for the whole organization. Until the management account uses Budgets, AWS refuses the $5 budget each environment creates in a member account with `Account ... is a linked account. To enable budgets for your account, ask the payer account to enable budgets first`.

One account also works. Skip the Organizations parts, 2 and 3 above, assign the permission set to that one account and make one profile. Use the same account id and profile in all three config files in step 4, and that profile wherever this guide names `multiscale-control`, `multiscale-staging` or `multiscale-prod`.

## 3. The domain (optional)

A domain is optional. Each environment gets a zone under it and serves its API at `api.<zone>`, its sign-in page at `auth.<zone>`, releases at `downloads.<zone>` and `release.<zone>`, and the web app at the zone itself, so the apps, the sign-in page and Google's redirect use your name rather than AWS's. Without one, the API and sign-in keep their AWS addresses and there's nowhere to release updates to: skip this step and step 6, and leave out the `dns` sections in step 4.

1. Open the AWS access portal, sign in to `multiscale-control`, and open **Route 53 > Registered domains > Register domains**.
2. Register the domain and confirm the contact email Route 53 sends. Registration can take from minutes to a day.

Route 53 also creates a hosted zone for the domain and points the domain at it. Keep it: the control stack uses it. Note its id, which starts with `Z`, from **Route 53 > Hosted zones**, or:

```sh
aws route53 list-hosted-zones-by-name --dns-name example.com --profile multiscale-control \
  --query "HostedZones[?Name=='example.com.'].Id" --output text   # your domain; the id follows /hostedzone/
```

## 4. The config folder

Your config lives in a folder of its own, kept in a private Git repository of yours, so it never goes near this public one. Every command reads it from `MULTISCALE_CONFIG_DIR`. Without that variable, commands read `config/` in this repo, where git ignores your files.

1. Create an empty private repository, for example `multiscale-config` on GitHub, and clone it:

   ```sh
   git clone git@github.com:<you>/multiscale-config.git ~/multiscale-config
   echo 'export MULTISCALE_CONFIG_DIR="$HOME/multiscale-config"' >> ~/.zshrc
   source ~/.zshrc
   for e in control staging prod; do cp config/$e.example.yaml "$MULTISCALE_CONFIG_DIR/$e.yaml"; done
   ```

2. Fill in all three files. The first deploy refuses any example value still in them. Keep account ids in quotes: without them YAML reads a number, and loading stops.

   `control.yaml`:

   | Field | Value |
   | --- | --- |
   | `aws.account` | The control account's id, from step 2. |
   | `aws.region` | `us-west-2`, unless you have a reason to move. |
   | `aws.profile` | `multiscale-control`. |
   | `dns.domain` | Your domain from step 3, such as `example.com`. Without one, delete the `dns` section. |
   | `dns.hostedZoneId` | The id of the zone Route 53 made for the domain in step 3, such as `Z0123456789ABCDEFGHIJ`. |
   | `dns.txt` | Optional. TXT values on the domain itself, such as `google-site-verification=…` from Google Search Console. |

   `staging.yaml` and `prod.yaml`:

   | Field | Value |
   | --- | --- |
   | `aws.account` | That environment's account id, from step 2. |
   | `aws.region` | `us-west-2`, unless you have a reason to move. |
   | `aws.profile` | `multiscale-staging` or `multiscale-prod`. |
   | `alarmEmail` | Where alarms and budget alerts go. |
   | `auth.cognitoDomainPrefix` | A globally unique name for the sign-in page, such as `multiscale-staging-` plus something of yours. Lowercase, without `aws`, `amazon` or `cognito`. |
   | `auth.signInCallbackUrls` | Leave as they are. iPhone returns to `multiscale://`, and a desktop install to `multiscale://` on prod and `multiscale-staging://` on staging. |
   | `dns.zone` | This environment's zone under your domain, such as `staging.example.com` and `app.example.com`. Without a domain, delete the `dns` section. |
   | `integration.testUser` | The email of a dedicated test user, created in step 8. No email is ever sent to it. |
   | `integration.capabilities` | Keep `googleClient`, set up in step 9. Add `secondUser` to also prove one user can't read another's records; it needs `integration.secondTestUser`, a second test user's email. Add `testCalendar` only if the test user is connected to a dedicated Google account, and only on staging: a deployment holds one Google connection, so connecting the test user replaces yours. |
   | `app.bundleId` | Optional. The Mac app's id, if you want your own, such as `com.yourname.multiscale`. Add it as `app:` with `bundleId:` below it. |

   No password or secret goes in these files. Test-user passwords go to SSM in step 8.

3. Commit them. `make deploy` adds `<env>.outputs.json`, the stack's outputs, and `<env>.deployed`, the commit it deployed and when. Commit after each deploy, and the repository records what is live with which config.

   ```sh
   (cd "$MULTISCALE_CONFIG_DIR" && git add -A && git commit -m "Config" && git push)
   ```

## 5. Bootstrap

Once per account and region. Bootstrapping an account twice is harmless, so this works for one shared account too:

```sh
cd infrastructure
npm ci
for p in multiscale-control multiscale-staging multiscale-prod; do
  AWS_PROFILE=$p npx cdk bootstrap "aws://$(aws sts get-caller-identity --profile $p --query Account --output text)/us-west-2"
done
# With a domain, the www page's stack lives in us-east-1, where CloudFront takes certificates.
AWS_PROFILE=multiscale-control npx cdk bootstrap "aws://$(aws sts get-caller-identity --profile multiscale-control --query Account --output text)/us-east-1"
cd ..
```

## 6. Deploy control

Only with a domain. Deploy it before staging and prod, which delegate their zones from it.

```sh
make deploy ENV=control
```

Every `make deploy` signs in with the `aws.profile` and `aws.region` in that environment's file, and stops if the signed-in account isn't its `aws.account`. This one lets the staging and prod accounts add their zones under the domain's zone. It never changes the domain's zone itself, apart from those records and `www`, and deleting the stack leaves it alone.

It also deploys `Multiscale-site` first: the pages in `site/` at `https://www.<your domain>`, served by CloudFront from a private bucket with a certificate it validates in the domain's zone. The first deploy takes about 10 minutes while the certificate and distribution come up. Google's consent screen setup asks for a home page and a privacy policy, which are `https://www.<your domain>/` and `https://www.<your domain>/privacy.html`.

To add a zone to staging or prod later, set its `dns.zone`, run `make deploy ENV=control` again, then deploy that environment. To remove one, do it the other way round: delete that environment's `dns` section and deploy it, which removes its record from the domain's zone while control still allows that, then deploy control. To rename one, remove it, then add the new name.

## 7. Deploy staging

```sh
make deploy
```

`ENV=staging` is the default. This checks `staging.yaml`, builds both Lambdas for arm64, deploys `Multiscale-staging`, and writes `staging.outputs.json` and `staging.deployed` to your config folder. CDK asks you to approve the new IAM roles the first time: answer `y`.

Then:

- Open the email from AWS Notifications and choose **Confirm subscription**, or alarms won't reach you.
- Commit the config folder, as in step 4.
- Load the outputs into your shell. Later steps use these:

  ```sh
  out() { node -p "require('$MULTISCALE_CONFIG_DIR/$1.outputs.json').$2"; }
  ```

The worker-silent alarm only watches a connected calendar: while none is connected, each run counts as a success.

## 8. Create the Cognito users

The `make` targets pick their profile from your config. Plain `aws` commands, in this step and the next two, use the one you export:

```sh
export AWS_PROFILE=multiscale-staging AWS_REGION=us-west-2
```

Self sign-up is off, so accounts exist only if you make them. Create one for yourself and the test user from `integration.testUser`. The integration suite signs in as the test user, so it never touches your data. Its password goes to SSM in the staging account, where the tests read it.

```sh
POOL=$(out staging UserPoolId)

# Your user. Use your own email. The password prompt doesn't echo.
EMAIL=you@example.com
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true --message-action SUPPRESS
read -rs "PASSWORD?Password: "; echo
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$EMAIL" --password "$PASSWORD" --permanent

# The test user: integration.testUser in staging.yaml.
TEST_EMAIL=integration-test@example.com
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$TEST_EMAIL" \
  --user-attributes Name=email,Value="$TEST_EMAIL" Name=email_verified,Value=true --message-action SUPPRESS
TEST_PASSWORD=$(openssl rand -hex 16)Aa1-
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$TEST_EMAIL" --password "$TEST_PASSWORD" --permanent
aws ssm put-parameter --type SecureString --name /multiscale/staging/test-user-password --value "$TEST_PASSWORD"
unset TEST_PASSWORD
```

With `secondUser` in `integration.capabilities`, make the user in `integration.secondTestUser` the same way, and store its password as `/multiscale/staging/second-test-user-password`. To change a stored password later, add `--overwrite`.

Passwords need 8 characters with upper case, lower case, a digit and a symbol.

## 9. Create the Google OAuth client

Staging and prod each get their own client. Use a Google account you are happy to test with on staging, because connecting creates a **Time blocks** calendar there.

1. At <https://console.cloud.google.com>, create a project named `multiscale-staging`.
2. Under **APIs & Services > Library**, enable **Google Calendar API**.
3. Open **Google Auth Platform** and choose **Get started**. Enter the app name and your email, pick **External** as the audience, and finish.
4. Under **Data Access > Add or remove scopes**, add these three, pasting each into **Manually add scopes**, then save:
   - `https://www.googleapis.com/auth/calendar.app.created`
   - `https://www.googleapis.com/auth/calendar.events.readonly`
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
5. Under **Clients > Create client**, choose **Web application**. Add one **Authorized redirect URI**, the exact output of:

   ```sh
   out staging GoogleRedirectUri
   ```

   Copy the client id and client secret.
6. **Move it to In production.** Under **Audience**, choose **Publish app** and confirm. Don't skip this: refresh tokens on a project in Testing expire after 7 days. You don't need to submit for verification.
7. Store the secrets. The API creates `refresh-token` itself when you connect.

   ```sh
   read -r "CLIENT_ID?Client id: "
   read -rs "CLIENT_SECRET?Client secret: "; echo
   aws ssm put-parameter --type SecureString --name /multiscale/staging/google/client-id --value "$CLIENT_ID"
   aws ssm put-parameter --type SecureString --name /multiscale/staging/google/client-secret --value "$CLIENT_SECRET"
   aws ssm put-parameter --type SecureString --name /multiscale/staging/google/state-secret --value "$(openssl rand -base64 32)"
   unset CLIENT_SECRET
   ```

## 10. Connect Google

You can do this from **Settings > Google Calendar > Connect** in the app once it's installed. To connect before any build exists, ask the API directly, signed in as yourself:

```sh
TOKEN=$(aws cognito-idp initiate-auth --client-id "$(out staging TestClientId)" --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters "{\"USERNAME\":\"$EMAIL\",\"PASSWORD\":\"$PASSWORD\"}" \
  --query AuthenticationResult.AccessToken --output text)
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$(out staging ApiUrl)/calendar/connect" |
  node -p 'const b = require("fs").readFileSync(0, "utf8"); try { JSON.parse(b).url ?? b } catch { b }'
unset PASSWORD TOKEN
```

`$EMAIL` and `$PASSWORD` are your own from step 8.

It prints the consent URL, decoded from the JSON response so its `&`s are intact, or the error if there's no URL. Open the URL within a few minutes. Google warns that it hasn't verified the app, which is expected for your own client: choose **Advanced**, then **Go to (app name)**, and allow the three scopes. Afterwards a **Time blocks** calendar appears in that Google account, and the worker keeps its token alive by running every 30 minutes.

## 11. Run the integration suite against staging

```sh
make test-integration ENV=staging
make smoke
```

Both read `staging.yaml` and `staging.outputs.json` from your config folder, and the test-user passwords from SSM with the file's profile and region. The suite signs in with the stack's test client, which allows password sign-in; the app's client doesn't.

The suite signs in as the test user, uses unique ids per run and cleans up. Its records stay behind as deleted rows in the test user's data, since sync never removes a row. Run one suite at a time against a deployment. Tests that need a fake clock or injected failures are listed as skipped. Google checks skip unless `testCalendar` is set. `make smoke` is the fast subset, and also confirms that a log line and the `SyncRecordsMerged` metric arrive in CloudWatch, which can take a few minutes. It warns if the calendar worker hasn't run yet, which is normal within 30 minutes of a first deploy.

Check the `Multiscale-staging` dashboard under **CloudWatch > Dashboards**. Nothing should be red.

The browser tests can also sign in to staging, as two devices of the same test user. They run the app at `http://localhost:5199`, so Cognito has to allow that as a sign-in callback. Add `http://localhost:5199/auth/callback` to `auth.signInCallbackUrls` in `staging.yaml`, run `make deploy` again, then:

```sh
(cd frontend && npm ci && npx playwright install chromium)   # once
make test-e2e ENV=staging
```

This builds the app from `staging.outputs.json`, signs in through the Cognito sign-in page as `integration.testUser`, with its password from SSM, and runs only the signed-in tests. Everything they create is deleted at the end, apart from the test user's settings. The sign-in expiry test needs the local stack's clock, so it's listed as skipped. Against prod it also needs `CONFIRM_PROD=yes`, and the same callback in `prod.yaml`.

Before a release, check this checkout's web bundle against the one prod serves, on the same callback:

```sh
make test-compat ENV=staging
```

This reads prod's version from its `version.json`, builds the web bundle at that commit and at this checkout, both for staging, and serves them from `http://localhost:5199`. One browser opens each in turn on the same data, as an update and a rollback after a failed trial do on a device, and then an old and a new device sign in as the test user and sync captures, dates, ticks and deletes both ways. `BASE=<commit>` picks a different old bundle. `make test-deployed` runs it against staging, and `make test-compat` and `make test-e2e` run it against a local stack, with `origin/main` as the old bundle when there's no config folder, as in CI.

The iPhone app's tests can do the same on the Simulator, with the `multiscale://auth/callback` callback that's already in the example config:

```sh
make test-ios ENV=staging
```

This runs only the signed-in test: the app signs in from Settings as the test user, captures an item, then deletes it, and the test checks both reached staging by signing in with the test client. Against prod it also needs `CONFIRM_PROD=yes`. With the default `ENV=local`, `make test-ios` starts its own local stack for that test, or lists it as skipped where Docker isn't running.

## 12. Deploy prod

Prod always takes an explicit `ENV=prod`:

```sh
make deploy ENV=prod
```

Then repeat for prod, replacing `staging` with `prod` everywhere, starting with `export AWS_PROFILE=multiscale-prod AWS_REGION=us-west-2` for plain `aws` commands:

1. Confirm the second alarm subscription email, and commit the config folder.
2. Step 8: create your user and the test user in the prod pool, with the password at `/multiscale/prod/test-user-password`.
3. Step 9: a new Google project and client `multiscale-prod`, with prod's redirect URI, moved to **In production**, and the three `/multiscale/prod/google/*` parameters.
4. Step 10: connect your real Google account.
5. Optionally, run the suite. It's safe, because it stays inside the test user:

   ```sh
   make test-integration ENV=prod CONFIRM_PROD=yes
   make smoke ENV=prod CONFIRM_PROD=yes
   ```

`Multiscale-prod` has termination protection on. Tables and user pools have deletion protection and are retained even if a stack is deleted, so check for leftovers if you ever tear down.

## 13. Build the desktop app

Builds take the environment, so a staging install and a prod install each reach their own backend. A build reads `<env>.outputs.json` and `<env>.yaml` from your config folder.

```sh
cd frontend
npm ci
ENV=prod npm run electron:build
cd ..
```

Open the disk image in `frontend/release/prod/` and drag **Multiscale** to Applications. It isn't notarized, so if macOS refuses to open it, choose **Open Anyway** under **System Settings > Privacy & Security**. Sign in with the prod user from step 12.

With a domain, release instead, and the installed apps keep themselves up to date. See [Releasing updates](#releasing-updates).

## 14. Install on your phone with a free personal team

This needs only an Apple ID, no membership.

1. In Xcode, open **Settings > Accounts** and add your Apple ID. Select it, choose **Manage Certificates**, and add an **Apple Development** certificate.
2. Find your team id, the 10 characters after `OU=`:

   ```sh
   security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject
   ```

3. Create your signing config, which git ignores:

   ```sh
   cp frontend/ios/App/Config.example.xcconfig frontend/ios/App/Config.local.xcconfig
   ```

   In it, set `DEVELOPMENT_TEAM` to that id. A free team also needs a bundle id nobody else has registered, so uncomment `MULTISCALE_BUNDLE_ID` and use something of your own, such as `com.yourname.multiscale`. Leave `MULTISCALE_EXTENSIONS` commented out.
4. Build and open the project:

   ```sh
   cd frontend
   npm ci
   ENV=prod npm run ios:sync
   open ios/App/App.xcodeproj
   cd ..
   ```

5. Connect the phone by cable, unlock it and tap **Trust**. Once Xcode has seen the phone, turn on **Settings > Privacy & Security > Developer Mode** on the phone and let it restart.
6. In Xcode, choose your phone as the run destination and press **Run**. If it reports a signing problem, open the **App** target's **Signing & Capabilities** and check that your Personal Team is selected.
7. The first launch is refused. On the phone, open **Settings > General > VPN & Device Management**, select your Apple ID and tap **Trust**. Then run again.

Limits of a free team:

- The install stops launching after **7 days**. Reconnect and press **Run** again. Your data stays.
- Three apps per device at a time.
- App Groups aren't available, so the share sheet is left out of the build. Everything else works, including notifications and the Control Center capture button, which only opens the app and so needs no App Group. On iOS 18, add it from Control Center's controls.

## 15. What changes with a paid membership

The Apple Developer Program costs about $99 a year; check the current price when you enroll.

1. Enroll at <https://developer.apple.com/programs/>.
2. In `frontend/ios/App/Config.local.xcconfig`, set `DEVELOPMENT_TEAM` to the paid team's id and uncomment `MULTISCALE_EXTENSIONS = YES`. That one setting builds in the share sheet, and App Groups now provision automatically.
3. In Xcode, press **Run** again.
4. Installs now last a year instead of 7 days. TestFlight builds, if you prefer them, last 90 days.

## Real-phone checklist

A Simulator can't prove these, so check them once on a real phone:

- [ ] Force-quit the app, wait for a block's notification, and tap each action. The answer is recorded.
- [ ] A notification fires with no network.
- [ ] Hold to drag and pinch to zoom feel right on Week.
- [ ] Key screens stay quick with a year or more of data.
- [ ] The Control Center capture button opens Capture.
- [ ] With a paid team: the share sheet saves into Inbox.

## Run it locally

No AWS and no config folder needed. Start the stand-ins and the local API, which also serves a stand-in sign-in that accepts anyone:

```sh
make up
cd backend && DYNAMODB_ENDPOINT=http://localhost:8000 SSM_ENDPOINT=http://localhost:5001 go run ./cmd/local
```

It listens on `localhost:8787`, which app builds without an `ENV` use by default. In another terminal, `make dev` serves the app in a browser, and `cd frontend && npm run electron:dev` opens the desktop app. `make down` stops the stand-ins, and their data goes with them.

To run several side by side, `scripts/local-stack.sh` starts all three on free ports, prints the API's URL as `LOCAL_API_URL=...`, and removes everything when stopped. Pass that variable to `npm run dev` or an app build to use it.

App builds share `frontend/dist` and the iOS build folders, so `npm run build`, `npm run ios:sync`, `npm run electron:build`, `make release`, `make test-ios` and the Electron part of `make test-e2e` take turns: one started while another runs says it's waiting and starts once the other is done.

## Day to day

| Job | Command |
| --- | --- |
| Deploy staging | `make deploy` |
| Deploy prod | `make deploy ENV=prod` |
| Let staging and prod delegate from the domain | `make deploy ENV=control` |
| Check a deployment's wiring | `make smoke` |
| Every suite against a deployment | `make test-deployed`, `make test-deployed ENV=prod CONFIRM_PROD=yes` |
| Unit and integration suites, no AWS | `make test` |
| App and iPhone tests, no AWS | `make test-e2e`, `make test-ios` |
| This checkout's web bundle beside prod's, on one device and syncing | `make test-compat`, `make test-compat ENV=staging` |
| Release the apps to staging, or prod | `make release`, `make release ENV=prod` |

Each signs in with the profile in its environment's file. After a deploy, commit your config folder.

### Releasing updates

`make release ENV=<env>` builds the Mac app and the web bundle on your Mac from a clean checkout, signs the bundle, and uploads the disk image to `https://downloads.<zone>/Multiscale.dmg`, the update feed to `https://release.<zone>`, and the web app to `https://<zone>`. Link people to the disk image to install.

Then it runs `make test-deployed` against what it just released, checking the web app serves that version, and fails if any suite does. The release is live by then, so to go back, revert the bad commit and release that. Releasing an older commit would only roll back the web app: its build number is its commit's time, and the apps skip any release whose build isn't newer than the one they run. `SKIP_TESTS=1` leaves the tests out, for a fix that can't wait; run `make test-deployed` after.

The web app keeps its data in the browser and syncs like the apps. It opens in one tab at a time, and it doesn't send reminders.

The first release makes the signing key, `<env>.release-key.pem`, in your config folder. Apps built after that carry its public half and install only bundles it signed, so keep it backed up. A lost key means building and installing the apps again with a new one.

How the apps update:

- **Most releases change only the web bundle**, which both apps download by themselves: soon after starting, every six hours, and on coming back after an hour away. The Mac app switches to it when its window closes or at its next launch. The phone switches at its next launch, or on returning after half an hour in the background. **Settings > Updates** shows the version, checks on request, and has **Restart now** for a downloaded update.
- **A release that changes native code**, such as Electron's main process, a Swift plugin or a Capacitor plugin, can't reach older apps this way. Each bundle names the native code it was built for, and an app skips a bundle that doesn't match. For the Mac app that includes the API, sign-in and release addresses its main process allows the page to reach, so moving any of them also needs a new Mac app. Settings then says the update needs a new version of the app, with a download link on the Mac. On the phone, run it from Xcode again.
- **A bundle that doesn't start** within 20 seconds is rolled back to the one before it and never tried again.

Releases are only as safe as the key: the apps check every bundle's signature and every file's hash before installing it, so someone who got into the bucket still couldn't change what runs.

### What the apps report

Signed-in apps send OpenTelemetry events in OTLP/HTTP JSON to the API's `POST /v1/logs`: a start, how the last run ended, a heartbeat each minute, memory warnings and uncaught errors, with memory figures on iPhone. They also report each update check's result, with why a failed one failed, and any update the app rolled back; the dashboard's **Update checks** and **Updates rolled back** panels show them. The API keeps only listed events and attributes, and only numbers and identifier-like strings, so nothing a person wrote is logged. Each kept event is a `client_event` line in the API's log group, which Logs Insights can query:

```sh
aws logs start-query --log-group-name "$(out staging ApiLogGroup)" --start-time $(($(date +%s) - 86400)) --end-time $(date +%s) \
  --query-string 'filter msg = "client_event" | fields @timestamp, event, `app.screen.name`, `process.memory.usage`, `app.last_session.state` | sort @timestamp desc'
```

Then `aws logs get-query-results --query-id <the id it printed>`. The app speaks plain OTLP, so an OpenTelemetry collector could receive it instead of the API.

Costs should stay under $1 a month per environment. A domain adds its yearly fee and $0.50 a month for each hosted zone, three in all. An AWS Budget emails `alarmEmail` above $5 a month. It covers the whole account, so with both environments in one account you may get two alerts for one overrun.

## Restoring the table from a backup

Point-in-time recovery restores into a new table. However you bring its items back into the stack's table, finish by giving the table a new generation. Every device then starts over and re-sends what the backup is missing. Skip it and a device that synced after the backup can lose that work:

```sh
export AWS_PROFILE=multiscale-prod AWS_REGION=us-west-2
aws dynamodb put-item --table-name "$(out prod TableName)" \
  --item "{\"pk\":{\"S\":\"meta\"},\"sk\":{\"S\":\"generation\"},\"value\":{\"S\":\"$(uuidgen)\"}}"
```
