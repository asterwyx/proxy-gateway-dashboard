# Repository Guidelines

## Project Structure & Module Organization

- `server.js` implements the native HTTP server, authentication, proxy routing, overview API, and Tailscale controls.
- `public/` contains dashboard/login HTML, JavaScript modules, shared CSS, the favicon, and Chinese/English translations in `i18n.js`.
- `test/dashboard.test.js` contains unit and integration tests with mock upstream services.
- `Dockerfile` packages the application; `.github/workflows/build.yml` runs tests and builds the Dashboard image. Zashboard is pulled from its official container registry as a separate sidecar.

## Build, Test, and Development Commands

Use Node.js 24 or newer. There are no npm dependencies or frontend compilation steps.

- `npm start` — start the server on `0.0.0.0:8080` after configuring credentials.
- `npm test` — run the full suite using `node --test`.
- `node --test --test-name-pattern='CSRF'` — run matching tests while iterating.
- `docker build -t proxy-gateway-dashboard .` — build the standalone image using `node:24-alpine`.

## Coding Style & Naming Conventions

Use ES modules, `node:` imports for built-ins, two-space JavaScript indentation, single quotes, and semicolons. Follow existing camelCase function/variable names and UPPER_SNAKE_CASE constants. Preserve surrounding formatting; no formatter or linter is configured. Keep UI strings synchronized across the `zh` and `en` dictionaries in `public/i18n.js`.

## Testing Guidelines

Use `node:test` and `node:assert/strict`; name test files `test/*.test.js` and give cases descriptive behavioral names. Reuse mock HTTP services, ephemeral ports, and temporary Unix sockets; clean resources with `t.after`. Tests should run without deployed upstreams or production credentials. Add regression coverage for changed authentication, CSRF, proxying, preference validation, and partial-failure behavior. No numeric coverage threshold is configured. Run `npm test` before submitting code changes.

## Commit & Pull Request Guidelines

The single existing commit, `feat: proxy gateway dashboard`, uses `<type>: <summary>`. Follow that style with concise summaries and appropriate prefixes such as `fix:` or `docs:`. Pull requests should explain behavior changes, link relevant issues, report validation, and include screenshots for UI changes. CI tests and container builds must pass; PR builds do not publish images.

## Security & Configuration

Set `DASHBOARD_USER`; point `DASHBOARD_PASSWORD_FILE`, `MIHOMO_SECRET_FILE`, and `OXIDNS_PASSWORD_FILE` at readable secret files. Configure `TS_SOCKET` for the Tailscale daemon. Restart after credential rotation. Never commit secrets or log credentials. Preserve fixed upstream destinations, server-side credential injection, CSRF checks, and `validatePrefs` restrictions. Keep upstream UI assets unchanged.
