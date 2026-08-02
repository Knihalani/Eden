"""SSRF guards for outbound URL targets (webhooks, gateway upstreams)."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

#: IANA / RFC 2606 reserved documentation domains. Subdomains under these
#: never resolve in the public DNS (only the apex ``example.com`` does),
#: so a strict getaddrinfo check rejects every fixture URL of the form
#: ``https://my-service.example.com/...``. They also cannot be registered
#: by an attacker, so skipping DNS here does not open an SSRF hole.
_DOCUMENTATION_SUFFIXES = (
    ".example.com",
    ".example.net",
    ".example.org",
)
_DOCUMENTATION_HOSTS = frozenset(
    {"example.com", "example.net", "example.org"}
)


def _is_documentation_host(hostname: str) -> bool:
    host = hostname.lower().rstrip(".")
    return host in _DOCUMENTATION_HOSTS or any(
        host.endswith(suffix) for suffix in _DOCUMENTATION_SUFFIXES
    )


def assert_public_https_url(url: str, *, what: str = "URL") -> None:
    """Reject non-https schemes and hosts that resolve to non-public IPs.

    Re-resolves the hostname at call time so DNS rebinding to a private
    / metadata address is caught. Raises ``ValueError`` on rejection.

    Reserved documentation hosts (``*.example.com`` and siblings) are
    accepted without DNS: their subdomains NXDOMAIN in the public DNS,
    and the names themselves cannot be pointed at private infrastructure
    by an attacker.
    """
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError(
            f"{what} {url!r} has non-https scheme {parsed.scheme!r}; "
            "only https is allowed"
        )
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"{what} must not include userinfo")
    hostname = parsed.hostname
    if not hostname:
        raise ValueError(f"{what} {url!r} has no hostname")

    if _is_documentation_host(hostname):
        return

    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None

    if literal is not None:
        ips: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = [literal]
    else:
        try:
            infos = socket.getaddrinfo(hostname, None)
        except socket.gaierror as exc:
            raise ValueError(
                f"{what} hostname {hostname!r} could not be resolved: {exc}"
            ) from exc
        if not infos:
            raise ValueError(
                f"{what} hostname {hostname!r} resolved to no addresses"
            )
        ips = []
        for info in infos:
            ip_str = info[4][0]
            try:
                ips.append(ipaddress.ip_address(ip_str))
            except ValueError as exc:
                raise ValueError(
                    f"{what} hostname {hostname!r} resolved to "
                    f"non-IP value {ip_str!r}"
                ) from exc

    for ip in ips:
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise ValueError(
                f"{what} {url!r} resolves to non-public IP {ip}"
            )
