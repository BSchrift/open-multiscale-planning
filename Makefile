# One entry point per job.
.PHONY: test test-unit test-frontend test-backend test-infra test-integration test-e2e test-ios test-deployed smoke deploy release scan update-skills dev up down

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

test-ios:
	@scripts/test-ios.sh

smoke:
	@scripts/smoke.sh

# Every suite that can run against a deployment: ENV=staging (default) or prod with CONFIRM_PROD=yes. make release
# runs it after each release. SKIP_IOS=1 leaves out the iPhone test.
test-deployed:
	@scripts/test-deployed.sh

# Defaults to staging. Prod takes an explicit ENV=prod, and ENV=control deploys the domain's DNS. Both deploy and smoke
# read <env>.yaml from MULTISCALE_CONFIG_DIR, else config/, and sign in with its aws.profile.
deploy:
	@scripts/deploy.sh

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
