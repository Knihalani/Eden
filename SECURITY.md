# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
through GitHub's **"Report a vulnerability"** feature on this repository's
Security tab (private vulnerability reporting).

If that is unavailable, contact the maintainer ([@Knihalani](https://github.com/Knihalani))
through GitHub and mention that you have a security report — details can then
be shared over a private channel.

Please include, where you can: the affected version or commit, steps to
reproduce, and the impact. You can expect an acknowledgement within a few days.

## Scope

Eden handles connected user data and credentials for source connectors. Issues
in scope include:

- Isolation breaks: state or content leaking across tenants, users or sessions.
- Secret-gate misses: a credential format that reaches storage, logs or a model
  call unredacted.
- Source access exceeding the read-only contract (any write call attempted).
- Authentication or authorization bypasses on the HTTP API and MCP server.
- Dependency or supply-chain problems in the published artifacts.

Out of scope: issues in third-party services Eden connects to, and attacks
requiring control of the machine Eden runs on beyond the threat model in
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Supported versions

The latest commit on `main` is supported. Eden is pre-release software; fixes
land on `main`.
