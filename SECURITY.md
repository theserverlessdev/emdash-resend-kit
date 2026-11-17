# Security policy

## Supported versions

The latest released version gets security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Report a vulnerability

Do not open a public issue for a vulnerability.

Use the private report function of GitHub:

1. Open <https://github.com/theserverlessdev/emdash-resend-kit/security/advisories/new>.
2. Describe the problem and the steps to reproduce it.
3. Include the version of `emdash-resend-kit` and the version of `emdash`.

Do not include a real API key or a real signing secret in a report.

## What to expect

- The maintainers answer a report in 5 working days.
- The maintainers tell you if they accept the report, and they tell you the plan for a fix.
- The maintainers publish a fixed version and a security advisory. The advisory credits you,
  unless you ask for no credit.

## Scope

These problems are in scope:

- A secret (API key or webhook signing secret) in the build output, in a log line, in an error
  message, or in an admin response.
- A webhook that the plugin accepts without a valid signature.
- Access to the admin route without the necessary permission.
- An email body in the storage of the plugin.

Problems in EmDash, Astro, Resend, or Cloudflare are out of scope. Report them to those projects.
