# One entry point per job.
.PHONY: test test-unit test-frontend test-backend test-infra test-integration test-e2e test-compat test-ios test-history test-deployed test-retention smoke deploy release scan update-skills dev up down

test: test-unit test-integration

test-unit: test-frontend test-backend test-infra

test-frontend:
	cd frontend && npm run typecheck && npm test

test-backend:
	cd config && go test ./... && cd ../backend && go test ./...

test-infra:
	cd infrastructure && npm test && npx cdk synth --quiet

# These take ENV=local (default, needs Docker, dummy credentials), staging or prod: the same suites on all three. Each
# script defaults ENV itself, so the deployment targets below default to staging and refuse local.
test-integration:
	@scripts/integration.sh

test-e2e:
	@scripts/e2e.sh

# The last release's web bundle beside this checkout's: one device's database opened by each in turn, and an old and a
# new device syncing. BASE picks the old bundle's commit. make test-e2e runs it too.
test-compat:
	@scripts/test-compat.sh

test-ios:
	@scripts/test-ios.sh

# A seeded five-year account, timed on the browser, the Mac app and the iPhone Simulator against the budgets in
# docs/performance.md. Slow, so it runs on demand and before releases. ENV=local (default) or staging.
# HISTORY_REPORT_ONLY=1 reports missed budgets and failed parts, and fails only on missing records; SKIP_IOS=1 leaves
# out the iPhone.
test-history:
	@scripts/test-history.sh

# Every suite that can run against a deployment: ENV=staging (default) or prod with CONFIRM_PROD=yes. make release
# runs it after each release. SKIP_IOS=1 leaves out the iPhone tests, and SKIP_HISTORY=1 the history-scale test, which
# runs on staging only, and only reports its numbers.
test-deployed:
	@scripts/test-deployed.sh

# Staging only: writes one record of each kind with the app's own client, then waits out staging's retention periods
# while its cleanup runs, about 25 minutes. make test-deployed runs it too, on staging.
test-retention:
	@scripts/test-retention.sh

# Defaults to staging. Prod takes an explicit ENV=prod, and ENV=control deploys the domain's DNS. Both deploy and smoke
# read <env>.yaml from MULTISCALE_CONFIG_DIR, else config/, and sign in with its aws.profile.
deploy:
	@scripts/deploy.sh

smoke:
	@scripts/smoke.sh

# Builds the Mac app and the web bundle on this Mac, signs the bundle and uploads both: ENV=staging (default) or prod.
release:
	@scripts/release.sh

# Updates the agent skills in .claude/skills to their latest releases, as .claude/skills/sources.tsv lists them.
update-skills:
	@scripts/update-skills.sh

scan:
	@if command -v gitleaks >/dev/null 2>&1; then gitleaks dir . --redact; \
	else docker run --rm -v "$(CURDIR):/repo" ghcr.io/gitleaks/gitleaks:v8.28.0 dir /repo --redact; fi

dev:
	cd frontend && npm run dev

up:
	docker compose up -d

down:
	docker compose down
