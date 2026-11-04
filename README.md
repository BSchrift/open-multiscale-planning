# Multiscale

A local-first personal task manager that connects long-term goals, projects, weekly plans and the day's time blocks. One React app runs on the desktop (Electron) and on iPhone (Capacitor). Everything is stored in SQLite on the device, syncs through a small serverless backend you host yourself, and mirrors time blocks to Google Calendar.

**Status:** early development. Nothing has been released yet.

Each deployment is self-hosted: you supply an AWS account, a Google OAuth client and, for iPhone, an Apple developer account. See [docs/setup.md](docs/setup.md).

```
make test-unit   # frontend and Go unit tests, no Docker
make test        # the full local suite; needs only Docker
make dev         # run the app in a browser
```

Licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only).
