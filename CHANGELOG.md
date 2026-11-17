# Changelog

This file lists all notable changes to this project.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - Unreleased

The first version. It supports EmDash 1.5.

### Added

- Email provider for EmDash through the exclusive `email:deliver` hook. The plugin sends the
  `to`, `cc`, `replyTo`, `subject`, `text`, and `html` fields of an EmDash message.
- The plugin reads the API key and the webhook signing secret at runtime. The sources are the
  Cloudflare Worker environment, `process.env`, and an encrypted plugin setting.
- A check that stops the build when the plugin options contain a secret.
- Sender configuration: default sender, default reply-to, default tags, default headers, and a
  configurable API base URL.
- Reliability: a timeout for each attempt, retries with exponential backoff and jitter, support
  for the `retry-after` header, and a deterministic idempotency key for each message.
- Typed errors (`ResendError`) with stable codes and clear messages.
- A dependency-free client for site code (`emdash-resend-kit/client`): send, batch send, get,
  update, cancel, list domains, and get a domain.
- A function that verifies a webhook signature with Web Crypto (`emdash-resend-kit/webhook`).
- A public webhook route that records delivery events.
- A delivery log with a retention time, a daily cleanup task, and privacy settings for
  recipient addresses.
- An optional suppression list for addresses with a hard bounce or a spam complaint.
- Admin pages: settings and status, test email, domain status, email log with filters, email
  details with the event timeline, and suppression list.
- A dashboard widget with the counts of the last 7 and 30 days.
- An example site in `examples/basic`.

[Unreleased]: https://github.com/theserverlessdev/emdash-resend-kit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/theserverlessdev/emdash-resend-kit/releases/tag/v0.1.0
