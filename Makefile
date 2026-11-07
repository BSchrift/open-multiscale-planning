# One entry point per job. Areas that don't exist yet say so and succeed, except deploy and smoke.
.PHONY: test test-unit test-frontend test-backend test-infra test-integration test-e2e test-ios smoke deploy release scan update-skills dev up down

COMPOSE_PROJECT ?= multiscale-test-$(shell date +%s)

test: test-unit test-integration

test-unit: test-frontend test-backend test-infra

test-frontend:
	cd frontend && npm run typecheck && npm test

test-backend:
	@if [ -f backend/go.mod ]; then cd config && go test ./... && cd ../backend && go test ./...; else echo "backend: not built yet, skipping"; fi

test-infra:
	@if [ -f infrastructure/package.json ]; then cd infrastructure && npm test && npx cdk synth --quiet; else echo "infrastructure: not built yet, skipping"; fi

# ENV is local (default, needs Docker, dummy credentials), staging or prod. Same suite on all three.
ENV ?= local
export ENV

test-integration:
	@if [ -x scripts/integration.sh ]; then COMPOSE_PROJECT_NAME="$(COMPOSE_PROJECT)" scripts/integration.sh; else echo "integration suite: not built yet, skipping"; fi

test-e2e:
	@if [ -x scripts/e2e.sh ]; then scripts/e2e.sh; else echo "e2e: not built yet, skipping"; fi

test-ios:
	@if [ -x scripts/test-ios.sh ]; then scripts/test-ios.sh; else echo "ios tests: not built yet, skipping"; fi

smoke:
	@if [ -x scripts/smoke.sh ]; then scripts/smoke.sh; else echo "smoke: not built yet"; exit 1; fi

# Defaults to staging. Prod takes an explicit ENV=prod, and ENV=control deploys the domain's DNS. Both deploy and smoke
# read <env>.yaml from MULTISCALE_CONFIG_DIR, else config/, and sign in with its aws.profile.
deploy:
	@if [ -x scripts/deploy.sh ]; then scripts/deploy.sh; else echo "deploy: not built yet"; exit 1; fi

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
