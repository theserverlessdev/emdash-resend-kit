# Basic example

A small EmDash site on Node with SQLite. It shows two things:

- The plugin as the email provider of EmDash (`astro.config.mjs`).
- The client in site code: a contact form endpoint (`src/pages/api/contact.ts`).

## Run the example

You need a Resend account with a verified domain.

1. Copy this folder to a new location.
2. Install the dependencies.

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in the values.
4. Change the sender address in `astro.config.mjs` and in `src/pages/api/contact.ts`. Use an
   address on your verified domain.
5. Start the development server with the variables of `.env`.

   ```bash
   node --env-file=.env node_modules/astro/bin/astro.mjs dev
   ```

6. Open <http://localhost:4321/_emdash/admin> and complete the setup wizard.
7. Open **Resend** in the sidebar and send a test email.

## Run the example in this repository

The integration test of the repository uses this folder. The test installs the local build of the
plugin and uses a mock of the Resend API, so it needs no Resend account.

```bash
npm run test:integration
```
