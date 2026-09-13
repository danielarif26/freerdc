# Security Policy

FreeRDC controls access to local files and should be treated as
security-sensitive software. Please report suspected vulnerabilities
privately through GitHub's private vulnerability reporting feature for this
repository. Do not open a public issue containing exploit details, secrets,
credentials, private paths, or user data.

Include the affected version, operating system, a minimal reproduction,
expected impact, and any suggested mitigation. Use synthetic data and redact
machine-specific identifiers. The maintainers aim to acknowledge reports,
assess severity, and coordinate a fix and disclosure, but cannot guarantee a
particular response or remediation timeline.

## Supported versions

Security fixes are currently intended for the latest `0.1.x` Community
Edition release. Older snapshots and untagged forks may not receive fixes.

## Operational security

- Bind FreeRDC only to loopback and use a private tunnel for remote access.
- Grant only narrow filesystem roots and keep the default sensitive-path
  policy enabled.
- Keep `~/.freerdc`, tunnel profiles, device state, and credentials private.
- Use a restricted tunnel runtime key; never use an admin key for the daemon.
- Do not enable process tools in the production CLI.
- Activate the `STOP` sentinel and disconnect remote access if compromise is
  suspected.

This policy is guidance, not a warranty or service-level commitment.
