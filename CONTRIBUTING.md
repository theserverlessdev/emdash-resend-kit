# How to contribute

Thank you for your interest in this project. This document tells you how to set up the project,
how to test a change, and how the maintainers release a version.

When you take part in this project, you agree to obey the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Before you start

- For a bug, open an issue first when the fix is not small.
- For a new feature, open an issue first. Describe the problem that the feature solves.
- For a security problem, do not open an issue. Read [SECURITY.md](./SECURITY.md).

## Set up the project

You need Node 22.16 or later and npm.

```bash
git clone https://github.com/theserverlessdev/emdash-resend-kit.git
cd emdash-resend-kit
npm install
```

## Commands

| Command                    | Function                                                            |
| -------------------------- | ------------------------------------------------------------------- |
| `npm run build`            | Build `dist` with tsdown.                                           |
| `npm run typecheck`        | Check the types with `tsc`.                                         |
| `npm run lint`             | Run oxlint.                                                         |
| `npm run format`           | Format all files with Prettier.                                     |
| `npm run format:check`     | Check the format.                                                   |
| `npm test`                 | Run the unit tests.                                                 |
| `npm run test:coverage`    | Run the unit tests with a coverage report.                          |
| `npm run test:integration` | Run a real EmDash site against a local mock of the Resend API.      |
| `npm run test:cloudflare`  | Build the Cloudflare starter with the plugin and run it in workerd. |
| `npm run check:package`    | Run publint and Are the Types Wrong.                                |
| `npm run check`            | Run all checks that CI runs.                                        |

Run `npm run check` before you open a pull request.

## Project structure

```text
src/
  index.ts            Plugin descriptor and plugin definition
  client.ts           Resend client for site code (no EmDash import)
  webhook.ts          Webhook signature verification (no EmDash import)
  errors.ts           ResendError and the mapping of API errors
  secrets.ts          Runtime resolution of secrets
  encoding.ts         Base64, hex, SHA-256, constant-time compare
  plugin/
    config.ts         Validation of options and the runtime configuration
    send.ts           Send path: suppression check, Resend call, log
    log.ts            Delivery log, daily counters, cleanup
    suppression.ts    Suppression list
    webhook-route.ts  Public webhook route
    admin.ts          Admin pages and the dashboard widget (Block Kit)
test/                 Unit tests (Vitest)
scripts/              Integration test, mock Resend server, Cloudflare checks
examples/basic/       Example EmDash site on Node
docs/                 Architecture, webhook events, FAQ
```

Read [docs/architecture.md](./docs/architecture.md) for the design.

## Tests

### Unit tests

The unit tests make no network call. They use a mocked `fetch` and storage in memory.

- Add a test for each change in behavior.
- Keep the line coverage of `src` above 90%. CI fails below that value.
- Compute test vectors for signatures with an independent implementation. The tests use
  `node:crypto` for that, and the source uses Web Crypto.

### Integration test

```bash
npm run test:integration
```

The script does these steps:

1. It builds and packs the plugin.
2. It copies `examples/basic` to `.integration/site` and installs the tarball.
3. It starts a local mock of the Resend API and the EmDash development server.
4. It checks the full flow through HTTP: provider selection, test email, invite email, retries,
   webhooks, the log, the suppression list, and the settings.

Add `-- --browser` to also check the admin pages in a headless browser. Install the browser first:

```bash
npx playwright install chromium
npm run test:integration -- --browser
```

Add `-- --keep` to keep the site active for manual checks.

### Cloudflare checks

```bash
npm run test:cloudflare
```

The command runs two scripts: `scripts/cloudflare-check.mjs` and `scripts/workerd-check.mjs`.

- The first script builds the EmDash Cloudflare starter with the plugin and runs
  `wrangler deploy --dry-run`. It also searches the build output for a marker API key.
- The second script runs the site in workerd on your computer and checks that the plugin reads its
  secrets at runtime.

The two scripts deploy nothing and need no Cloudflare account.

## Code style

- TypeScript in strict mode, ES modules only.
- No runtime dependencies. Use `fetch`, Web Crypto, and other Web APIs.
- Do not import a Node built-in module in `src`. The code must run on Cloudflare Workers.
- `src/client.ts` and `src/webhook.ts` must not import `emdash`.
- Never write a secret to a log line, an error message, or an admin response.
- Never store the body of an email.

## Writing style

All prose in this project follows a controlled-language style. This includes documentation, code
comments, UI text, error messages, and commit messages.

- Write short sentences: 25 words or fewer.
- Use the active voice and simple tenses.
- Use one word for one meaning.
- Do not use idioms or humour.
- Do not use a slash to mean "and" or "or".
- Use a vertical list for more than two items.
- Quote code and identifiers exactly.

## Commit messages

- Start with a verb in the imperative: "Add", "Fix", "Remove", "Change".
- Keep the first line at 72 characters or fewer.
- Explain the reason in the body when the reason is not obvious.

## Pull requests

1. Create a branch from `main`.
2. Make the change, and add tests.
3. Run `npm run check`.
4. Add a line to the `Unreleased` section of [CHANGELOG.md](./CHANGELOG.md).
5. Open the pull request and fill in the template.

## Release process

Only maintainers release a version. The release workflow publishes to npm with trusted publishing
(OIDC). The repository holds no npm token.

### One-time setup

1. Publish the first version by hand. npm needs an existing package before you can add a trusted
   publisher.

   ```bash
   npm login
   npm run check
   npm publish --access public --provenance=false
   ```

   The flag `--provenance=false` is necessary for this one publish. Provenance needs a CI
   environment.

2. Open the package settings on npmjs.com. Find the section **Trusted Publisher** and select
   **GitHub Actions**.
3. Enter these values:
   - Organization or user: `theserverlessdev`
   - Repository: `emdash-resend-kit`
   - Workflow filename: `release.yml`
   - Environment name: `npm`
4. Create the environment `npm` in the settings of the GitHub repository. Add a required reviewer
   if you want an approval step before each publish.
5. In the package settings on npmjs.com, open **Publishing access**. Select **Require two-factor
   authentication and disallow tokens**.

### Each release

1. Change `version` in `package.json` and `VERSION` in `src/version.ts`. A unit test fails when the
   two values are different.
2. Move the entries of `Unreleased` in `CHANGELOG.md` to a new version section with the date.
3. Run `npm run check` and `npm run test:integration`.
4. Commit the change with the message `Release vX.Y.Z`.
5. Create and push the tag.

   ```bash
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

The workflow checks that the tag matches `package.json`, runs all checks, publishes the package
with provenance, and creates a GitHub release.
