/** Hot RFC titles for wrap + gold. No zlib / RT11 — first inject must not parse rfc-titles.bin. */
const RFC_HOT_D = [20, 15, 733, 23, 1, 80, 87, 75, 1, 2226, 725, 641, 1828, 1804, 741, 110, 1, 198] as const;
const RFC_HOT_T = `ASCII format for network interchange
Network Meeting
User Datagram Protocol
Internet Protocol
Internet Control Message Protocol
TCP-on-a-LAN
File Transfer Protocol
Domain names - concepts and facilities
Domain names - implementation and specification
SIP: Session Initiation Protocol
Uniform Resource Identifier (URI): Generic Syntax
The application/json Media Type for JavaScript Object Notation (JSON)
The WebSocket Protocol
The JavaScript Object Notation (JSON) Data Interchange Format
QUIC: A UDP-Based Multiplexed and Secure Transport
HTTP Semantics
HTTP Caching
Robots Exclusion Protocol`;

function buildRfcTitleHot(): Record<number, string> {
  const titles = RFC_HOT_T.split("\n");
  const out: Record<number, string> = {};
  let n = 0;
  for (let i = 0; i < RFC_HOT_D.length; i++) {
    n += RFC_HOT_D[i]!;
    out[n] = titles[i]!;
  }
  return out;
}

export const RFC_TITLE_HOT: Record<number, string> = buildRfcTitleHot();
export const RFC_TITLE_HOT_PACKED = { d: [...RFC_HOT_D], t: RFC_HOT_T };

export function rfcTitleHot(n: number): string | undefined {
  return RFC_TITLE_HOT[n];
}
