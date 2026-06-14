"""GitHub App integration — used by the onboarding wizard's
'Connect GitHub' step to open SDK-integration pull requests against
user repos.

See :mod:`eden.integrations.github.oauth` for the OAuth client.
"""

from eden.integrations.github.oauth import (
    GitHubAPIError,
    GitHubConfigError,
    GitHubOAuthClient,
    InstallationRepo,
    InstallationToken,
    is_configured,
    verify_webhook_signature,
)

__all__ = [
    "GitHubAPIError",
    "GitHubConfigError",
    "GitHubOAuthClient",
    "InstallationRepo",
    "InstallationToken",
    "is_configured",
    "verify_webhook_signature",
]
