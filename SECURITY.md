# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in Connectum, report it
privately through GitHub private vulnerability reporting:

**[Report a vulnerability](https://github.com/Connectum-Framework/connectum/security/advisories/new)**

The report is visible only to you and the repository maintainers.

Do **not** open a public issue, pull request or discussion for a suspected
vulnerability, and do not post exploit details, credentials, tokens or
private application contracts in any public place.

## Security reports and ordinary bugs

| What you found | Where to report it |
|----------------|--------------------|
| A suspected vulnerability (for example, a way to bypass authentication or authorization, or to read data that should not be readable) | The private route above |
| An ordinary bug, an unexpected error, or a feature request | A public [issue](https://github.com/Connectum-Framework/connectum/issues/new/choose) |

If you are unsure which category applies, use the private route. The
maintainers can move a report to public tracking after review.

## What to include

- The affected `@connectum/*` package names and versions.
- The runtime and its version (Node.js, Bun or another runtime).
- A description of the impact and the steps to reproduce it.
- A minimal example that demonstrates the problem, with all secrets and
  application-specific data removed.

## Scope and expectations

This policy only describes how to send a report. It makes no commitment about
response times or about which versions receive fixes.
