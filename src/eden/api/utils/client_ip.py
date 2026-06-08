"""Proxy-aware client IP extraction for rate limiting and audit logging.

In production Eden runs behind a load balancer / CDN.  The raw
`request.client.host` is the proxy's IP, not the end user's.

This module extracts the real client IP from standard forwarding headers
while guarding against IP-spoofing attacks from untrusted sources.
"""

import ipaddress
import logging
from typing import Optional

from fastapi import Request

logger = logging.getLogger(__name__)

# List of trusted proxy IPs (CIDR notation).  Override via env if needed.
# Example: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1/32"
TRUSTED_PROXY_CIDRS: list[str] = []


def _parse_trusted_proxies(cidrs: list[str]) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    """Parse CIDR strings into network objects."""
    networks = []
    for cidr in cidrs:
        try:
            networks.append(ipaddress.ip_network(cidr, strict=False))
        except ValueError:
            logger.warning(f"Invalid trusted proxy CIDR: {cidr}")
    return networks


def _is_trusted_proxy(ip: str, trusted: list[ipaddress.IPv4Network | ipaddress.IPv6Network]) -> bool:
    """Check if an IP address belongs to a trusted proxy network."""
    try:
        addr = ipaddress.ip_address(ip)
        for net in trusted:
            if addr in net:
                return True
    except ValueError:
        pass
    return False


def get_client_ip(request: Request, trusted_proxy_cidrs: Optional[list[str]] = None) -> str:
    """Extract the real client IP from a FastAPI request.

    Priority:
    1. X-Forwarded-For (last untrusted IP in the chain)
    2. X-Real-IP
    3. request.client.host (direct connection)

    Args:
        request: The FastAPI Request object.
        trusted_proxy_cidrs: Optional override for trusted proxy CIDRs.
            If not provided, uses the module-level TRUSTED_PROXY_CIDRS.

    Returns:
        The best-effort client IP address, or "unknown" if unavailable.
    """
    raw_client = request.client.host if request.client else None

    cidrs = trusted_proxy_cidrs if trusted_proxy_cidrs is not None else TRUSTED_PROXY_CIDRS
    trusted = _parse_trusted_proxies(cidrs) if cidrs else []

    # If no trusted proxies are configured, trust the direct connection only.
    # This prevents spoofing in environments without a known proxy.
    if not trusted:
        return raw_client or "unknown"

    # Verify the immediate peer is a trusted proxy.
    if raw_client and not _is_trusted_proxy(raw_client, trusted):
        logger.debug(
            "Direct client %s is not in TRUSTED_PROXY_CIDRS; "
            "possible spoofing attempt. Falling back to direct IP.",
            raw_client,
        )
        return raw_client or "unknown"

    # X-Forwarded-For: client, proxy1, proxy2, ...
    # The leftmost is the original client, but that can be spoofed by the client itself.
    # A safer heuristic: walk from the right, skipping known proxies, until we hit the
    # first non-proxy IP.  This is the last untrusted hop.
    x_forwarded_for = request.headers.get("x-forwarded-for")
    if x_forwarded_for:
        ips = [ip.strip() for ip in x_forwarded_for.split(",")]
        # Walk from right to left
        for ip in reversed(ips):
            if not _is_trusted_proxy(ip, trusted):
                return ip
        # All IPs in the chain are trusted proxies — return the leftmost (original client)
        return ips[0] if ips else raw_client or "unknown"

    # Fallback to X-Real-IP (set by some proxies)
    x_real_ip = request.headers.get("x-real-ip")
    if x_real_ip:
        return x_real_ip.strip()

    return raw_client or "unknown"
