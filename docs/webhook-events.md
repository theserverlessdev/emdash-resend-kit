# Webhook events

Resend sends a webhook for each event of an email. This table shows what the plugin does with each
event type.

Source: <https://resend.com/docs/dashboard/webhooks/event-types>

## Email events

| Event                    | Status in the log | Dashboard counter | Suppression list                               |
| ------------------------ | ----------------- | ----------------- | ---------------------------------------------- |
| `email.sent`             | Sent              | Sent              | No change                                      |
| `email.scheduled`        | Scheduled         | None              | No change                                      |
| `email.delivered`        | Delivered         | Delivered         | No change                                      |
| `email.delivery_delayed` | Delayed           | None              | No change                                      |
| `email.opened`           | Opened            | Opened            | No change                                      |
| `email.clicked`          | Clicked           | Clicked           | No change                                      |
| `email.bounced`          | Bounced           | Bounced           | Adds the recipient, if the bounce is permanent |
| `email.complained`       | Complained        | Complained        | Adds the recipient                             |
| `email.failed`           | Failed            | Failed            | No change                                      |
| `email.suppressed`       | Suppressed        | Suppressed        | No change                                      |
| `email.received`         | Ignored           | None              | No change                                      |

Notes:

- The plugin counts `Sent` when Resend accepts the email. The `email.sent` webhook adds a counter
  only for an email that site code sent with the client.
- `Opened` and `Clicked` need open tracking and click tracking on the domain in Resend.
- The suppression list changes only when the setting **Skip addresses that bounced or complained**
  is on.
- `email.suppressed` means that the address is on the suppression list of your Resend account.
  The plugin shows the status. It does not copy the address to its own list.
- `email.received` is an event for inbound email. This version does not support inbound email.

## Status rank

Webhooks can arrive in the wrong order. A status with a higher rank replaces a status with a lower
rank. A status with a lower rank adds an event to the timeline, and the status does not change.

| Rank | Status                       |
| ---- | ---------------------------- |
| 0    | Scheduled                    |
| 1    | Sent                         |
| 2    | Delayed                      |
| 3    | Delivered                    |
| 4    | Opened                       |
| 5    | Clicked                      |
| 6    | Failed, Suppressed, Canceled |
| 7    | Bounced                      |
| 8    | Complained                   |

## Other events

The plugin acknowledges these events with status `200` and stores nothing:

- `domain.*`
- `contact.*`
- `suppression.*`
- `topic.*`
- `inbox.*`

You can select only the `email.*` events in the Resend dashboard.

## Event detail

The timeline shows a short detail for some events.

| Event              | Detail                                                |
| ------------------ | ----------------------------------------------------- |
| `email.bounced`    | Bounce type, bounce subtype, and the bounce message   |
| `email.failed`     | The failure reason, for example `reached_daily_quota` |
| `email.suppressed` | The suppression type and message                      |
| `email.clicked`    | The host of the link                                  |

The plugin stores only the host of a link, because a link in an invite contains a token.
The plugin does not store the IP address or the user agent of an open or a click.

A bounce or a complaint changes the suppression list only for an email with one recipient. The
event does not say which recipient of an email caused it.

## Payload example

```json
{
  "type": "email.bounced",
  "created_at": "2026-11-22T23:41:12.126Z",
  "data": {
    "email_id": "56761188-7520-42d8-8898-ff6fc54ce618",
    "from": "Website <website@mail.example.com>",
    "to": ["person@example.com"],
    "subject": "Your invite",
    "bounce": {
      "type": "Permanent",
      "subType": "General",
      "message": "The mailbox does not exist."
    }
  }
}
```

## Request headers

| Header           | Content                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `svix-id`        | ID of the webhook message. A repeat has the same ID.              |
| `svix-timestamp` | Unix time in seconds.                                             |
| `svix-signature` | One or more signatures: `v1,<base64>`, with a space between them. |

The signed text is `<svix-id>.<svix-timestamp>.<raw body>`. The key is the Base64 part of the
signing secret after `whsec_`. The algorithm is HMAC SHA-256.
