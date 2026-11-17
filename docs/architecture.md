# Architecture

This document describes the design of `emdash-resend-kit` and the reasons for the main decisions.

## Overview

The package has three entry points.

| Entry point                 | Content                                            | Imports `emdash` |
| --------------------------- | -------------------------------------------------- | ---------------- |
| `emdash-resend-kit`         | Plugin descriptor (`resendKit`) and `createPlugin` | Yes              |
| `emdash-resend-kit/client`  | Resend client for site code                        | No               |
| `emdash-resend-kit/webhook` | Webhook signature verification                     | No               |

The package has no runtime dependencies. `emdash` is a peer dependency.

```text
EmDash email pipeline                     Resend
        |                                    ^
        v                                    |
  email:deliver hook  -->  send path  -->  client  -->  POST /emails
                              |
                              v
                        delivery log  <--  webhook route  <--  Resend webhooks
                              |
                              v
                 admin pages and dashboard widget
```

## Native plugin

EmDash has two plugin formats:

- A **sandboxed** plugin runs in an isolate. On Cloudflare, that needs Worker Loader, which is a
  feature of the Workers Paid plan.
- A **native** plugin runs in the site process. It works on each plan and on Node.

This package is a native plugin. The site owner adds it to `astro.config.mjs`, and the Astro build
bundles it with the site.

The runtime code of the plugin uses only the plugin context of EmDash and Web APIs. It uses
`ctx.http`, `ctx.storage`, `ctx.settings`, `ctx.kv`, `ctx.cron`, and `ctx.log`. A sandboxed build
is possible for that reason. It is on the roadmap.

## Secrets

EmDash calls `createPlugin(options)` at runtime with options that it serialised to JSON at build
time. The JSON is part of the server bundle. A secret in the options is thus a secret in the
bundle.

The plugin has three protections:

1. The options have no field for a secret. They have fields for the names of environment
   variables.
2. `validateOptions` throws when the options contain `apiKey`, `webhookSecret`, or a similar key.
   The descriptor function calls it, so the Astro build stops.
3. `validateOptions` also rejects an `apiKeyEnv` value that does not have the form of a variable
   name. This catches a secret in the wrong field.

At runtime, `resolveConfig` reads the secrets for each hook call and each route call:

1. `env` from `cloudflare:workers`. The code imports the module with a computed specifier in a
   `try` block. A bundler does not try to resolve it, and Node rejects the import without an
   effect.
2. `process.env`.
3. An encrypted plugin setting (`ctx.settings`).

The plugin does not cache a secret between calls. A rotated secret is active on the next request.

## Send path

`src/plugin/send.ts` contains the send path. The `email:deliver` hook and the test button use it.

1. Resolve the configuration.
2. Stop when the API key or the sender is missing.
3. When suppression is on, look up the recipient in the suppression list.
4. Compute the idempotency key.
5. Call `client.send`.
6. Record the result in the delivery log.
7. Throw a `ResendError` when the send failed. EmDash reports the error to the caller.

### Timeouts

EmDash stops a hook after its timeout. The default is 5 seconds, which is too short for a send
with retries. The plugin sets these limits:

| Limit                          | Value      |
| ------------------------------ | ---------- |
| One HTTP attempt (`timeoutMs`) | 10 seconds |
| One send with all retries      | 25 seconds |
| The `email:deliver` hook       | 30 seconds |

An attempt never runs past the limit of the send. The client shortens the timeout of the last
attempt to the time that is left.

### Idempotency

EmDash gives a message no ID. The plugin computes the key from the content:

```text
emdash/<time window number>/<SHA-256 of from, to, cc, reply-to, subject, text, html, source>
```

- Each attempt of one send has the same key. A retry after a timeout cannot send two emails.
- A repeat of the same message in the same window also has the same key. This protects against a
  double submit.
- The window is 60 seconds by default. A longer window blocks an intended repeat for a longer
  time.

### HTTP access

The plugin sends requests through `ctx.http.fetch`. EmDash allows only the hosts that the plugin
declares: `api.resend.com`, and the host of `baseUrl` when you set one.

EmDash blocks plugin requests to local addresses. A `baseUrl` on `localhost` is for tests with a
mock server, so the plugin uses the global `fetch` for that case only.

## Delivery log

The plugin declares three storage collections.

| Collection     | Record ID                      | Content                           |
| -------------- | ------------------------------ | --------------------------------- |
| `emails`       | Resend email ID, or a local ID | One email with its event timeline |
| `suppressions` | SHA-256 hash of the address    | One suppressed address            |
| `stats`        | UTC date (`YYYY-MM-DD`)        | Counters of one day               |

- The record ID of an email is the Resend ID. A webhook finds its record with one read.
- A send that Resend did not accept has no Resend ID. Its record ID starts with `local-`.
- Webhooks can arrive at the same time. The plugin updates a record with a compare-and-set loop.
- Webhooks can arrive in the wrong order. Each status has a rank, and the higher rank stays.
  For example, `delivered` does not replace `bounced`.
- A record keeps the newest 50 events.
- Each event has the webhook ID. The plugin ignores a webhook that it stored before.

The dashboard widget reads the `stats` collection. The plugin increments a counter with an atomic
update. It counts each event type one time for one email.

A failure of the log never stops an email. The send path catches the error and writes a warning.

## Webhook route

The route `webhook` is public. It declares a text body, so EmDash gives the raw body to the
handler. The signature check needs the raw body.

The handler does these steps:

1. Resolve the signing secret. Answer `503` when it is missing.
2. Verify the signature and the timestamp. Answer `401` or `400` when the check fails.
3. Apply an `email.*` event to the log.
4. Add the recipient to the suppression list for a permanent bounce or a complaint.

## Admin pages

The admin pages use Block Kit, the declarative UI format of EmDash. The plugin returns JSON, and
the EmDash admin renders it.

The reasons for this decision:

- The pages always have the look of the EmDash admin, also after an EmDash update.
- The package needs no React, no UI library, and no browser build.
- The official native plugins with React pages pin an exact version of the UI library. Block Kit
  has no such pin.
- The same pages can work in a sandboxed build.

All interactions go to one private route, `admin`. EmDash sends `page_load`, `block_action`, and
`form_submit` interactions. The server holds no state for a page. The filters of the log travel in
the cursor of the table and in the value of each button.

## Domain status

The settings page calls `GET /domains` and `GET /domains/{id}` of the Resend API. The plugin keeps
the result in `ctx.kv` for 60 seconds, because each interaction renders the page again.

## Scheduled cleanup

The plugin schedules the task `cleanup` with `ctx.cron` (`@daily`). It creates the task in the
`plugin:activate` hook and also when an administrator opens an admin page. The second path exists
because a plugin from the site configuration does not always get an activate event.
