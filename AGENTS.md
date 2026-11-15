# Repository Guidelines

## Project Structure & Module Organization

- `server.js` implements the native HTTP server, authentication, proxy routing, overview API, and Tailscale controls.
- `public/` contains dashboard/login HTML, JavaScript modules, shared CSS, the favicon, Chinese/English translations in `i18n.js`, and upstream preference injection.
- `test/dashboard.test.js` contains unit and integration tests with mock upstream services.
- `Dockerfile` packages the application; `.github/workflows/build.yml` tests and builds the Dashboard image. Zashboard runs from its official image as a separate sidecar and is never bundled here.

## Build, Test, and Development Commands

Use Node.js 24 or newer. No npm dependencies or frontend build step are required.

- `npm start` — start the server on `0.0.0.0:8080` after configuring credentials.
- `npm test` — run the full suite using `node --test`.
- `node --test --test-name-pattern='CSRF'` — run matching tests while iterating.
- `docker build -t proxy-gateway-dashboard .` — build the standalone image using `node:24-alpine`.

## Coding Style & Naming Conventions

Use ES modules, `node:` imports, two-space JavaScript indentation, single quotes, and semicolons. Use camelCase names and UPPER_SNAKE_CASE constants. Preserve surrounding formatting; no formatter or linter is configured. Synchronize UI strings between the `zh` and `en` dictionaries in `public/i18n.js`.

## Testing Guidelines

Use `node:test` and `node:assert/strict`; name test files `test/*.test.js` and use descriptive behavioral names. Reuse mock HTTP services, ephemeral ports, and temporary Unix sockets; clean resources with `t.after`. Tests must run without deployed upstreams or production credentials. Cover changes to authentication, CSRF, proxying, preference injection, strategy switching, legacy-frontend migration, and partial failures. No numeric coverage threshold is configured. Run `npm test` before submitting. The focused migration check is `node --test --test-name-pattern='legacy Yacd' test/dashboard.test.js`; it needs permission to bind a local port.

## Commit & Pull Request Guidelines

Use concise `<type>: <summary>` messages, such as `feat:`, `fix:`, or `docs:`. Pull requests should explain behavior, link issues, report validation, and include UI screenshots. CI tests and image builds must pass; pull requests do not publish images.

## Security & Configuration

Set `DASHBOARD_USER`; point `DASHBOARD_PASSWORD_FILE`, `MIHOMO_SECRET_FILE`, and `OXIDNS_PASSWORD_FILE` at readable secret files. Configure `TS_SOCKET` for tailscaled. Restart after credential rotation. Never commit secrets or log credentials. Preserve fixed upstreams, server-side credential injection, CSRF checks, and `validatePrefs` restrictions. Keep upstream assets unchanged except the first-navigation migration that removes the retired Yacd service worker. Keep `vendor/yacd/` and `vendor/zashboard/` as ignored local references; deploy Zashboard only from its official image.
