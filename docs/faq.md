# FAQ

## Does the plugin need the Cloudflare Workers Paid plan?

No. The plugin is a native plugin. It runs in the Worker of the site.

Only sandboxed plugins need Worker Loader, which is a feature of the Workers Paid plan.

## Why is the plugin not in the EmDash plugin registry?

The registry at <https://plugins.emdashcms.com> lists sandboxed plugins only. The EmDash
documentation says: "Native packages cannot be published to the EmDash registry."

A native plugin is an npm package. You install it with npm and add it to `astro.config.mjs`.

A sandboxed build of this plugin is on the roadmap. Such a build cannot read environment
variables, so it can use only the encrypted settings for its secrets.

## How do people find a native plugin?

- npm: the package has the keywords `emdash` and `emdash-plugin`.
- GitHub: the repository can have the topics `emdash` and `emdash-plugin`.

## Which emails does the plugin send?

Each email that EmDash sends through its email pipeline:

- Invites.
- Magic links.
- Comment notices.
- Notifications of other plugins, for example the forms plugin.
- The test email of **Settings**, **Email**.

## Can I send a `bcc`, an attachment, or a scheduled email through EmDash?

No. An EmDash 1.5 message has the fields `to`, `cc`, `replyTo`, `subject`, `text`, and `html`.

Use the client of this package in your site code for the other Resend fields. Read the section
"Client for site code" in the README.

## Why does a send through the client not show in the log immediately?

The client is independent of the plugin. It writes no log record.

When you set up the webhook, the log gets a record with the first event of the email. The source
of that record is `external`.

## Where does the plugin store its data?

In the EmDash database, in the storage of the plugin. The plugin uses these collections:
`emails`, `suppressions`, and `stats`. It also uses the plugin settings and one cache key.

## How do I delete all data of the plugin?

1. Set the retention time to 1 day, or turn the log off.
2. Remove the addresses on the **Suppressions** page.
3. Remove the stored secrets on the **Resend** page.

EmDash removes the storage of a plugin when you uninstall the plugin in the admin.

## Does the plugin store the body of an email?

No. The log stores the recipient, the subject, the status, and the events. Read the section
"Delivery log and privacy" in the README.

## Can I use more than one sender address?

The plugin has one default sender for EmDash email. EmDash gives a message no sender field.

Use the client in your site code to send with a different sender.

## Can I use the EU region of Resend?

Yes. You select the region when you add a domain in Resend. The API base URL is the same for all
regions. You do not need the `baseUrl` option.

## What is the `baseUrl` option for?

- A public HTTPS proxy in front of the Resend API.
- A local mock server in tests. The option accepts `http://localhost` and `http://127.0.0.1`.

EmDash blocks plugin requests to private network addresses. A proxy on a private address does not
work.

## Does the plugin work with EmDash middleware plugins?

Yes. An `email:beforeSend` plugin can change or cancel a message before the plugin gets it. EmDash
does not run those hooks for system email, for example invites and magic links.

## How many requests does one email need?

One request to Resend for each email. A retry adds one request.

The settings page makes at most two requests to the Domains API for each minute that an
administrator has the page open.

## Does a retry send an email two times?

No. Each attempt has the same idempotency key. Resend sends one email for one key in 24 hours.

## Which Resend plan do I need?

Each plan works, including the free plan. The quota of your plan applies. The plugin does not try
again when Resend reports a quota error.

## How do I rotate the API key?

1. Create a new key in Resend.
2. Store the new key: `npx wrangler secret put RESEND_API_KEY`, or change the environment variable.
3. Send a test email on the **Resend** page.
4. Delete the old key in Resend.

The plugin reads the key for each send. On Cloudflare, a new secret is active after the command
completes.
