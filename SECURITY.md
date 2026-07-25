# Security policy

## Supported versions

`pi-workflow` is in pre-release development and has no supported published version yet.

| Version | Supported |
| --- | --- |
| `0.0.0-development` | Best effort only |
| Unreleased source branches | No |

After the first release, the latest published pre-1.0 minor line is supported unless its release notes state otherwise. Older lines receive fixes only when the maintainer explicitly announces extended support.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, pull request, commit, or test fixture.

Use [GitHub private vulnerability reporting](https://github.com/psmfd/pi-workflow/security/advisories/new) and include:

- the affected version, commit, or workflow;
- reproduction steps or a proof of concept;
- expected and observed behavior;
- impact and prerequisites;
- any suggested mitigation;
- whether the report is subject to a disclosure deadline.

Do not include active credentials, personal data, or third-party secrets. Use synthetic values and describe sensitive evidence instead.

The maintainer aims to acknowledge a complete report within three business days, provide an initial assessment within seven business days, and send weekly updates while remediation is active. These are response goals, not guarantees.

If private reporting is temporarily unavailable, open a public issue requesting private contact **without vulnerability details**. Do not send sensitive evidence until a private channel is established.

## Response and disclosure

The maintainer will validate the report, assess affected versions, coordinate a fix and advisory, and credit the reporter unless anonymity is requested. Disclosure timing is coordinated with the reporter when practical, but the maintainer may publish earlier to protect users from active exploitation.

A confirmed credential exposure requires immediate revocation and rotation. Removing a secret from the latest commit is not remediation because it may remain in history, caches, logs, artifacts, or forks.

Security fixes follow the protected-branch and release gates. An active incident may accelerate review and release coordination, but it does not authorize direct pushes or rewritten history. Released fixes use a new version and immutable tag; an existing release is never silently replaced.

## Security expectations for contributions

Contributors must follow the deterministic and least-privilege requirements in [CONTRIBUTING.md](CONTRIBUTING.md). In particular:

- never commit credentials, private keys, tokens, or realistic secret fixtures;
- never expose repository or publication secrets to untrusted pull-request code;
- keep workflow permissions minimal and job-scoped;
- pin external actions and container images immutably;
- obtain explicit review for dependency or permission expansion;
- treat repository scanning as defense in depth, not permission to store secrets.
