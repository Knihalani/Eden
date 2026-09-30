/** Closed decoder tables. Objects that match are omitted from the pack and rebuilt on load.
 * HTTP_REASON / PROTO_NAME are official IANA maps (codec); they are not in closedTables JSON.
 */
import { ISO2_TAB } from "./iso3166";
import { WELLKNOWN_KEEP } from "./names";
import { dnsRrNames } from "./dns-rr";
import { httpMethodNames } from "./http-methods";
import { charsetNames } from "./charset-tab";
import { unicodeBlockNames } from "./unicode-block-tab";
import { mediaTypeNames } from "./media-type-tab";
import { schemeNames } from "./scheme-tab";
import { spdxIds } from "./spdx-tab";
import { w3cNames } from "./w3c-tab";
import { httpFieldNames } from "./http-field-tab";
import { relNames } from "./rel-tab";

export const HTTP_REASON: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  104: "Upload Resumption Supported (TEMPORARY - registered 2024-11-13, extensio",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  306: "(Unused)",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "(Unused)",
  421: "Misdirected Request",
  422: "Unprocessable Content",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended (OBSOLETED)",
  511: "Network Authentication Required",
};

export const PROTO_NAME: Record<number, string> = {
  0: "HOPOPT",
  1: "ICMP",
  2: "IGMP",
  3: "GGP",
  4: "IPv4",
  5: "ST",
  6: "TCP",
  7: "CBT",
  8: "EGP",
  9: "IGP",
  10: "BBN-RCC-MON",
  11: "NVP-II",
  12: "PUP",
  13: "ARGUS (deprecated)",
  14: "EMCON",
  15: "XNET",
  16: "CHAOS",
  17: "UDP",
  18: "MUX",
  19: "DCN-MEAS",
  20: "HMP",
  21: "PRM",
  22: "XNS-IDP",
  23: "TRUNK-1",
  24: "TRUNK-2",
  25: "LEAF-1",
  26: "LEAF-2",
  27: "RDP",
  28: "IRTP",
  29: "ISO-TP4",
  30: "NETBLT",
  31: "MFE-NSP",
  32: "MERIT-INP",
  33: "DCCP",
  34: "3PC",
  35: "IDPR",
  36: "XTP",
  37: "DDP",
  38: "IDPR-CMTP",
  39: "TP++",
  40: "IL",
  41: "IPv6",
  42: "SDRP",
  43: "IPv6-Route",
  44: "IPv6-Frag",
  45: "IDRP",
  46: "RSVP",
  47: "GRE",
  48: "DSR",
  49: "BNA",
  50: "ESP",
  51: "AH",
  52: "I-NLSP",
  53: "SWIPE (deprecated)",
  54: "NARP",
  55: "Min-IPv4",
  56: "TLSP",
  57: "SKIP",
  58: "IPv6-ICMP",
  59: "IPv6-NoNxt",
  60: "IPv6-Opts",
  62: "CFTP",
  64: "SAT-EXPAK",
  65: "KRYPTOLAN",
  66: "RVD",
  67: "IPPC",
  69: "SAT-MON",
  70: "VISA",
  71: "IPCV",
  72: "CPNX",
  73: "CPHB",
  74: "WSN",
  75: "PVP",
  76: "BR-SAT-MON",
  77: "SUN-ND",
  78: "WB-MON",
  79: "WB-EXPAK",
  80: "ISO-IP",
  81: "VMTP",
  82: "SECURE-VMTP",
  83: "VINES",
  84: "IPTM",
  85: "NSFNET-IGP",
  86: "DGP",
  87: "TCF",
  88: "EIGRP",
  89: "OSPFIGP",
  90: "Sprite-RPC",
  91: "LARP",
  92: "MTP",
  93: "AX.25",
  94: "IPIP",
  95: "MICP (deprecated)",
  96: "SCC-SP",
  97: "ETHERIP",
  98: "ENCAP",
  100: "GMTP",
  101: "IFMP",
  102: "PNNI",
  103: "PIM",
  104: "ARIS",
  105: "SCPS",
  106: "QNX",
  107: "A/N",
  108: "IPComp",
  109: "SNP",
  110: "Compaq-Peer",
  111: "IPX-in-IP",
  112: "VRRP",
  113: "PGM",
  115: "L2TP",
  116: "DDX",
  117: "IATP",
  118: "STP",
  119: "SRP",
  120: "UTI",
  121: "SMP",
  122: "SM (deprecated)",
  123: "PTP",
  124: "ISIS over IPv4",
  125: "FIRE",
  126: "CRTP",
  127: "CRUDP",
  128: "SSCOPMCE",
  129: "IPLT",
  130: "SPS",
  131: "PIPE",
  132: "SCTP",
  133: "FC",
  134: "RSVP-E2E-IGNORE",
  135: "Mobility Header",
  136: "UDPLite",
  137: "MPLS-in-IP",
  138: "manet",
  139: "HIP",
  140: "Shim6",
  141: "WESP",
  142: "ROHC",
  143: "Ethernet",
  144: "AGGFRAG",
  145: "NSH",
  146: "Homa",
  147: "BIT-EMU",
};

export const SCHEME_OBJECT: Record<string, string> = {
  http: "Hypertext Transfer Protocol",
  https: "Hypertext Transfer Protocol Secure",
  mailto: "Electronic mail address",
  ws: "WebSocket connections",
  wss: "Encrypted WebSocket connections",
  ftp: "File Transfer Protocol",
  file: "Host-specific file names",
  data: "data",
  blob: "blob",
  git: "git",
  ssh: "ssh",
  urn: "Uniform Resource Names",
  about: "about",
  sftp: "query",
  ldap: "Lightweight Directory Access Protocol",
  ldaps: "ldaps",
  tel: "Telephone",
  sms: "SMS",
  sip: "Session Initiation Protocol",
  sips: "SIP over TLS",
  xmpp: "Extensible Messaging and Presence Protocol",
  did: "Decentralized Identifier",
  geo: "Geographic location",
  magnet: "Magnet",
  ipfs: "InterPlanetary File System",
  irc: "Internet Relay Chat",
  mqtt: "MQTT",
  coap: "Constrained Application Protocol",
  coaps: "CoAP over DTLS",
  stun: "Session Traversal Utilities for NAT",
  turn: "Traversal Using Relays around NAT",
  webcal: "webcal",
  rtsp: "Real Time Streaming Protocol",
};

export const SPDX_OBJECT: Record<string, string> = {
  MIT: "MIT License",
  "MIT-0": "MIT No Attribution",
  "Apache-2.0": "Apache License 2.0",
  "Apache-1.1": "Apache License 1.1",
  "BSD-1-Clause": "BSD 1-Clause License",
  "BSD-2-Clause": 'BSD 2-Clause "Simplified" License',
  "BSD-3-Clause": 'BSD 3-Clause "New" or "Revised" License',
  ISC: "ISC License",
  "GPL-2.0-only": "GNU General Public License v2.0 only",
  "GPL-2.0-or-later": "GNU General Public License v2.0 or later",
  "GPL-3.0-only": "GNU General Public License v3.0 only",
  "GPL-3.0-or-later": "GNU General Public License v3.0 or later",
  "LGPL-2.1-only": "GNU Lesser General Public License v2.1 only",
  "LGPL-3.0-only": "GNU Lesser General Public License v3.0 only",
  "LGPL-3.0-or-later": "GNU Lesser General Public License v3.0 or later",
  "MPL-2.0": "Mozilla Public License 2.0",
  "AGPL-3.0-only": "GNU Affero General Public License v3.0 only",
  "AGPL-3.0-or-later": "GNU Affero General Public License v3.0 or later",
  Unlicense: "The Unlicense",
  "CC0-1.0": "Creative Commons Zero v1.0 Universal",
  "CC-BY-4.0": "Creative Commons Attribution 4.0 International",
  "CC-BY-SA-4.0": "Creative Commons Attribution Share Alike 4.0 International",
  "0BSD": "BSD Zero Clause License",
  "BlueOak-1.0.0": "Blue Oak Model License 1.0.0",
  "BSL-1.0": "Boost Software License 1.0",
  "EPL-2.0": "Eclipse Public License 2.0",
  "OFL-1.1": "SIL Open Font License 1.1",
  "EUPL-1.2": "European Union Public License 1.2",
  "UPL-1.0": "Universal Permissive License 1.0",
  "Artistic-2.0": "Artistic License 2.0",
  "CDDL-1.0": "Common Development and Distribution License 1.0",
  "Python-2.0": "Python License 2.0",
  "MS-PL": "Microsoft Public License",
};

export const LANG_OBJECT: Record<string, string> = {
  en: "English",
  fr: "French",
  de: "German",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  sv: "Swedish",
  pl: "Polish",
  ru: "Russian",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  hi: "Hindi",
  tr: "Turkish",
  uk: "Ukrainian",
  vi: "Vietnamese",
  th: "Thai",
  id: "Indonesian",
  cs: "Czech",
  ro: "Romanian",
  el: "Modern Greek (1453-)",
  he: "Hebrew",
  fa: "Persian",
  da: "Danish",
  fi: "Finnish",
  no: "Norwegian",
  nb: "Norwegian Bokmål",
  hu: "Hungarian",
  sk: "Slovak",
  bg: "Bulgarian",
  hr: "Croatian",
  sr: "Serbian",
  ms: "Malay",
  bn: "Bengali",
  ta: "Tamil",
  ur: "Urdu",
  sw: "Swahili",
  ca: "Catalan",
  eu: "Basque",
  ga: "Irish",
  lt: "Lithuanian",
  lv: "Latvian",
  et: "Estonian",
  af: "Afrikaans",
};

export const SCRIPT_OBJECT: Record<string, string> = {
  Latn: "Latin",
  Cyrl: "Cyrillic",
  Grek: "Greek",
  Arab: "Arabic",
  Hans: "Han (Simplified variant)",
  Hant: "Han (Traditional variant)",
  Jpan: "Japanese",
  Kore: "Korean",
  Hebr: "Hebrew",
  Deva: "Devanagari",
  Thai: "Thai",
};

export const WHATWG_OBJECT: Record<string, string> = {
  html: "HTML",
  fetch: "Fetch",
  url: "The URL Standard defines the infrastructure around URLs on the web.",
  dom: "The DOM Standard defines the core infrastructure used to define the web.",
  encoding: "Encoding",
  notifications: "Notifications API",
  xhr: "XMLHttpRequest",
  storage: "Storage",
  websockets: "WebSockets",
  workers: "Workers",
  compat: "Compatibility",
  mimesniff: "MIME Sniffing",
  console: "Console",
  streams: "Streams",
  cookiestore: "Cookie Store API",
  fullscreen: "Fullscreen API",
  infra: "Infra",
  webbluetooth: "WebBluetooth",
  webhid: "WebHID",
  webnfc: "WebNFC",
  webserial: "WebSerial",
  webusb: "WebUSB",
  quirks: "Quirks Mode",
  fs: "File System",
  compression: "Compression",
  testutils: "Test Utils",
  urlpattern: "URL Pattern",
  webidl: "Web IDL",
};

export const W3C_OBJECT: Record<string, string> = {
  "web-share": "Web Share API",
  encoding: "Encoding",
  "json-ld11": "JSON-LD 1.1",
  html: "HTML",
  "wasm-core-2": "WebAssembly Core Specification",
  uievents: "UI Events",
  fetch: "Fetch",
  url: "URL",
  dom: "DOM",
  "css-color-4": "CSS Color Module Level 4",
  imsc: "IMSC",
  "wai-aria-1.2": "Accessible Rich Internet Applications (WAI-ARIA) 1.2",
  webrtc: "WebRTC 1.0",
  "wcag-22": "Web Content Accessibility Guidelines 2.2",
  "webauthn-3": "Web Authentication",
  "service-workers": "Service Workers",
  "push-api": "Push API",
  webgpu: "WebGPU",
  webcodecs: "WebCodecs",
  "did-core": "Decentralized Identifiers (DIDs) v1.0",
  geolocation: "Geolocation API",
  "clipboard-apis": "Clipboard API and events",
  fileapi: "File API",
  webaudio: "Web Audio API",
  csp3: "Content Security Policy Level 3",
  permissions: "Permissions",
  "indexeddb-3": "Indexed Database API 3.0",
  "css-flexbox-1": "CSS Flexible Box Layout Module Level 1",
  "css-grid-1": "CSS Grid Layout Module Level 1",
  pointerevents3: "Pointer Events",
};

/** Well-known URI objects. Names live in names.WELLKNOWN_KEEP; pack omits matching objects. */
export const WELLKNOWN_MEANING_BLOB = `ACME Challenge
AI Plugin Manifest
API Catalog
Apple App Site Association
Digital Asset Links
AT Protocol DID
CalDAV
CardDAV
Change Password
DID Configuration
DID Document
Do Not Track
Global Privacy Control
host-meta
host-meta JSON
JSON Web Key Set
MTA-STS
NodeInfo
OAuth Authorization Server
OAuth Client
OAuth Protected Resource
OpenID Configuration
OpenID Credential Issuer
OpenID Federation
Passkey Endpoints
security.txt
TDM Reservation Protocol
Time
Web Identity
WebAuthn
WebFinger`;

function buildWellknownObject(): Record<string, string> {
  const names = [...WELLKNOWN_KEEP].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const means = WELLKNOWN_MEANING_BLOB.split("\n");
  const out: Record<string, string> = {};
  for (let i = 0; i < names.length; i++) out[names[i]!] = means[i] ?? names[i]!;
  return out;
}

export const WELLKNOWN_OBJECT: Record<string, string> = buildWellknownObject();

/** Charset meanings aligned to charset-tab. Empty line = name is the meaning. */
export const CHARSET_MEANING_BLOB = `Big5
Extended_UNIX_Code_Packed_Format_for_Japanese
EUC-KR
GB18030
GB2312
GBK
IBM437
ISO-2022-JP
ISO_8859-1:1987
ISO-8859-10
ISO-8859-13
ISO-8859-14
ISO-8859-15
ISO-8859-16
ISO_8859-2:1987
ISO_8859-3:1988
ISO_8859-4:1988
ISO_8859-5:1988
ISO_8859-6:1987
ISO_8859-7:1987
ISO_8859-8:1988
ISO_8859-9:1989
KOI8-R
KOI8-U

Shift_JIS
US-ASCII
UTF-8








`;

function buildCharsetObject(): Record<string, string> {
  const ns = charsetNames();
  const means = CHARSET_MEANING_BLOB.split("\n");
  const out: Record<string, string> = {};
  for (let i = 0; i < ns.length; i++) {
    const m = means[i] ?? "";
    out[ns[i]!] = m || ns[i]!;
  }
  return out;
}

export const CHARSET_OBJECT: Record<string, string> = buildCharsetObject();

/** Packed method flags+RFC. Names live in http-methods (codec). bit0=unsafe, bit1=idempotent, rest=RFC. */
export const METHOD_META = [14979, 13015, 23371, 13015, 13015, 36441, 19675, 36443, 36442, 36442, 13015, 8275, 19673, 13015, 13015, 19167, 19675, 17751, 13015, 19675, 36442, 14595, 23157, 36441, 36454, 19674, 19675, 36443, 40034, 23371, 13014, 21294, 36442, 23371, 13015, 8275, 19675, 13015, 17751, 13015] as const;

function formatMethodMeta(meta: number): string {
  return `${meta & 1 ? "unsafe" : "safe"}${meta & 2 ? ", idempotent" : ""}, RFC ${meta >>> 2}`;
}

function buildMethodObject(): Record<string, string> {
  const names = httpMethodNames();
  const out: Record<string, string> = {};
  for (let i = 0; i < names.length; i++) out[names[i]!] = formatMethodMeta(METHOD_META[i]!);
  return out;
}

export const METHOD_OBJECT: Record<string, string> = buildMethodObject();

/** DNS RR/RCODE meanings aligned to dns-rr names. Empty line = mnemonic is the meaning. */
export const DNS_MEANING_BLOB = `A6 (OBSOLETE - use AAAA)
IP6 Address
for AFS Data Base location
Automatic Multicast Tunneling Relay

ATM Address
Application Visibility and Control
transfer of an entire zone
Algorithm not supported
Bad/missing Server Cookie
Key not recognized
Bad TKEY Mode
Duplicate key name
TSIG Signature Failure
Signature out of time window
Bad Truncation
Bad OPT Version
UAS Broadcast Remote Identification
Certification Authority Restriction
DNSKEY(s) the Child wants reflected in DS
Child DS

BP Convergence Layer Adapter
the canonical name for an alias
Child-To-Parent Synchronization

DNSSEC Lookaside Validation (OBSOLETE)


Digital Object Architecture
Delegation Signer
DSO-TYPE Not Implemented
Endpoint discovery for delegation synchronization
Endpoint Identifier
an EUI-48 address
an EUI-64 address
Format Error

Geographical Position
Hierarchical Host Identity Tag
host information
Host Identity Protocol
SVCB-compatible type for use with HTTP
Immediately process this CSYNC record.
BP Node Number

for ISDN address
Value coded per an ISO standard
incremental transfer
for security key
Key Exchanger


Location Information
mail agent RRs (OBSOLETE - see MX)
mailbox-related RRs (MB, MG or MR)
Internet mail
a mailbox domain name (EXPERIMENTAL)
a mail destination (OBSOLETE - use MX)
a mail forwarder (OBSOLETE - use MX)
a mail group member (EXPERIMENTAL)
mailbox or mail list information
a mail rename domain name (EXPERIMENTAL)
mail exchange
Naming Authority Pointer

Nimrod Locator

No Error
Not Authorized
Not Implemented
Name not contained in zone
an authoritative name server
for NSAP address, NSAP style A record (DEPRECATED)
for domain name pointer, NSAP style (DEPRECATED)



a null RR (EXPERIMENTAL)
Non-Existent Domain
NXDOMAIN indicator for Compact Denial of Existence
RR Set that should exist does not
Next Domain (OBSOLETE)
OpenPGP Key

a domain name pointer
X.400 mail mapping information
Query Refused
Resolver Information as Key/Value Pairs

for Responsible Person

for Route Through
Server Failure
for security signature

S/MIME cert association
marks the start of a zone of authority
Require a SOA serial number greater than the one specified.

Server Selection
SSH Key Fingerprint
General-purpose service binding
DNSSEC Trust Authorities
Trust Anchor LINK
Telephone Number
Transaction Key

Transaction Signature
text strings


Value coded per a UNECE Recommendation


Public wallet address
a well known service description
for X.25 PSDN address
Name Exists when it should not
RR Set Exists when it should not
Message Digest Over Zone Data`;

function buildDnsObject(): Record<string, string> {
  const names = dnsRrNames();
  const means = DNS_MEANING_BLOB.split("\n");
  const out: Record<string, string> = {};
  for (let i = 0; i < names.length; i++) {
    const m = means[i] ?? "";
    out[names[i]!] = m || names[i]!;
  }
  return out;
}

export const DNS_OBJECT: Record<string, string> = buildDnsObject();

export const MEDIA_OBJECT: Record<string, string> = {
  "application/javascript": "javascript (OBSOLETED in favor of text/javascript)",
  "application/json": "JSON",
  "application/pdf": "PDF",
  "application/wasm": "WebAssembly",
  "application/xml": "XML",
  "application/zip": "ZIP",
  "image/gif": "GIF",
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/svg+xml": "SVG",
  "text/css": "CSS",
  "text/html": "HTML",
  "text/javascript": "JavaScript",
  "text/xml": "XML",
  "video/jpeg": "JPEG",
};

/** Unicode block ranges aligned to unicode-block-tab names. */
export const UNICODE_BLOCK_BLOB = `U+0600..U+06FF
U+0000..U+007F
U+4E00..U+9FFF
U+0400..U+04FF
U+AC00..U+D7AF
U+3040..U+309F
U+30A0..U+30FF
U+0080..U+00FF
U+E000..U+F8FF`;

function buildUnicodeBlockObject(): Record<string, string> {
  const ns = unicodeBlockNames();
  const means = UNICODE_BLOCK_BLOB.split("\n");
  const out: Record<string, string> = {};
  for (let i = 0; i < ns.length; i++) out[ns[i]!] = means[i] ?? "";
  return out;
}

export const UNICODE_BLOCK_OBJECT: Record<string, string> = buildUnicodeBlockObject();

/** KEEP header names for old empty T_HEADER + closed bit 6. New dumps use http-field-tab. */
export const HEADER_LIST = ["A-IM","ALPN","AMP-Cache-Transform","Accept","Accept-Additions","Accept-CH","Accept-Datetime","Accept-Encoding","Accept-Features","Accept-Language","Accept-Patch","Accept-Post","Accept-Query","Accept-Ranges","Accept-Signature","Access-Control-Allow-Credentials","Access-Control-Allow-Headers","Access-Control-Allow-Methods","Access-Control-Allow-Origin","Access-Control-Expose-Headers","Access-Control-Max-Age","Access-Control-Request-Headers","Access-Control-Request-Method","Activate-Storage-Access","Age","Allow","Alt-Svc","Alt-Used","Alternates","Apply-To-Redirect-Ref","Authentication-Control","Authentication-Info","Authorization","Available-Dictionary","CDN-Cache-Control","CDN-Loop","CMCD-Object","CMCD-Request","CMCD-Session","CMCD-Status","CMSD-Dynamic","CMSD-Static","CTA-Common-Access-Token","Cache-Control","Cache-Group-Invalidation","Cache-Groups","Cache-Status","Cal-Managed-ID","CalDAV-Timezones","Capsule-Protocol","Cert-Not-After","Cert-Not-Before","Clear-Site-Data","Client-Cert","Client-Cert-Chain","Close","Concealed-Auth-Export","Configuration-Context","Connect-UDP-Bind","Connection","Content-Digest","Content-Disposition","Content-Encoding","Content-Language","Content-Length","Content-Location","Content-Range","Content-Security-Policy","Content-Security-Policy-Report-Only","Content-Type","Cookie","Cross-Origin-Embedder-Policy","Cross-Origin-Embedder-Policy-Report-Only","Cross-Origin-Opener-Policy","Cross-Origin-Opener-Policy-Report-Only","Cross-Origin-Resource-Policy","DASL","DAV","DPoP","DPoP-Nonce","Date","Delta-Base","Deprecation","Depth","Destination","Detached-JWS","Dictionary-ID","EDIINT-Features","ETag","Early-Data","Expect","Expires","Forwarded","From","Hobareg","Host","IM","If","If-Match","If-Modified-Since","If-None-Match","If-Range","If-Schedule-Tag-Match","If-Unmodified-Since","Include-Referred-Token-Binding-ID","Incremental","Isolation","Keep-Alive","Label","Last-Event-ID","Last-Modified","Link","Link-Template","Location","Lock-Token","MIME-Version","Max-Forwards","Memento-Datetime","Meter","NEL","Negotiate","OData-EntityId","OData-Isolation","OData-MaxVersion","OData-Version","OSCORE","OSLC-Core-Version","Optional-WWW-Authenticate","Ordering-Type","Origin","Origin-Agent-Cluster","Overwrite","Permissions-Policy","Ping-From","Ping-To","Position","Prefer","Preference-Applied","Priority","Proxy-Authenticate","Proxy-Authentication-Info","Proxy-Authorization","Proxy-Public-Address","Proxy-Status","Public-Key-Pins","Public-Key-Pins-Report-Only","Range","Redirect-Ref","Referer","Referrer-Policy","Refresh","Repeatability-Client-ID","Repeatability-First-Sent","Repeatability-Request-ID","Repeatability-Result","Replay-Nonce","Reporting-Endpoints","Repr-Digest","Retry-After","SLUG","Schedule-Reply","Schedule-Tag","Sec-Fetch-Dest","Sec-Fetch-Mode","Sec-Fetch-Site","Sec-Fetch-Storage-Access","Sec-Fetch-User","Sec-GPC","Sec-Purpose","Sec-Token-Binding","Sec-WebSocket-Accept","Sec-WebSocket-Extensions","Sec-WebSocket-Key","Sec-WebSocket-Protocol","Sec-WebSocket-Version","Server","Server-Timing","Set-Cookie","Set-Txn","Signature","Signature-Input","SoapAction","Status-URI","Strict-Transport-Security","Sunset","Surrogate-Capability","Surrogate-Control","TCN","TE","TTL","Timeout","Timing-Allow-Origin","Topic","Traceparent","Tracestate","Trailer","Transfer-Encoding","Unencoded-Digest","Upgrade","Urgency","Use-As-Dictionary","User-Agent","Variant-Vary","Vary","Via","WWW-Authenticate","Want-Content-Digest","Want-Repr-Digest","Want-Unencoded-Digest","X-Content-Type-Options","X-Frame-Options"] as const;
export const SCHEME_LIST = ["about","blob","data","file","ftp","git","http","https","ldap","ldaps","mailto","sftp","ssh","urn","ws","wss"] as const;
export const SPDX_LIST = ["0BSD","AGPL-3.0-only","Apache-2.0","BSD-2-Clause","BSD-3-Clause","BlueOak-1.0.0","CC0-1.0","GPL-2.0-only","GPL-3.0-only","ISC","LGPL-3.0-only","MIT","MPL-2.0","Unlicense"] as const;
export const WHATWG_LIST = ["compat","compression","console","cookiestore","dom","encoding","fetch","fs","fullscreen","html","infra","mimesniff","notifications","quirks","storage","streams","testutils","url","urlpattern","webbluetooth","webhid","webidl","webnfc","webserial","websockets","webusb","xhr"] as const;
export const W3C_LIST = ["css-color-4","encoding","html","json-ld11","uievents","wai-aria-1.2","wasm-core-2","web-share"] as const;
export const LANG_LIST = ["cs","de","el","en","es","fr","he","hi","id","it","ja","ko","nl","pl","pt","ro","ru","sv","th","tr","uk","vi"] as const;
export const SCRIPT_LIST = ["Arab","Cyrl","Deva","Grek","Hebr","Latn","Thai"] as const;

/** Closed-scheme objects; names live in SCHEME_LIST / names.SCHEME_KEEP. Empty = identity. */
export const SCHEME_MEANING_BLOB = SCHEME_LIST.map((k) => {
  const v = SCHEME_OBJECT[k] ?? "";
  return v === k ? "" : v;
}).join("\n");

/** Closed KEEP media objects; names live in media-type-tab (codec). */
export const MEDIA_MEANING_BLOB = Object.keys(MEDIA_OBJECT)
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  .map((k) => MEDIA_OBJECT[k]!)
  .join("\n");

function meaningBlob(obj: Record<string, string>, keys: readonly string[]): string {
  return keys.map((k) => obj[k] ?? "").join("\n");
}

/** Closed catalog objects; names live in the LIST consts closedCatalog already uses. */
export const SPDX_MEANING_BLOB = meaningBlob(SPDX_OBJECT, SPDX_LIST);
export const LANG_MEANING_BLOB = meaningBlob(LANG_OBJECT, LANG_LIST);
export const SCRIPT_MEANING_BLOB = meaningBlob(SCRIPT_OBJECT, SCRIPT_LIST);
export const WHATWG_MEANING_BLOB = meaningBlob(WHATWG_OBJECT, WHATWG_LIST);
export const W3C_MEANING_BLOB = meaningBlob(W3C_OBJECT, W3C_LIST);

export type ClosedCat = {
  headers: string[];
  dns: string[];
  charset: string[];
  media: string[];
  spdx: string[];
  scheme: string[];
  whatwg: string[];
  w3c: string[];
  methods: string[];
  langs: string[];
  scripts: string[];
  blocks: string[];
  wellknown: string[];
  rels: string[];
  protoBits: Uint8Array;
  httpBits: Uint8Array;
};

function sortedKeys(o: Record<string, string>): string[] {
  return Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

let _closed: ClosedCat | undefined;
export function closedCatalog(): ClosedCat {
  if (_closed) return _closed;
  const protoBits = new Uint8Array(32);
  for (const k of Object.keys(PROTO_NAME)) {
    const n = Number(k);
    protoBits[n >> 3]! |= 1 << (n & 7);
  }
  const httpBits = new Uint8Array(128);
  for (const k of Object.keys(HTTP_REASON)) {
    const n = Number(k);
    if (n >= 0 && n < 1024) httpBits[n >> 3]! |= 1 << (n & 7);
  }
  _closed = {
    headers: httpFieldNames(),
    dns: sortedKeys(DNS_OBJECT),
    charset: sortedKeys(CHARSET_OBJECT),
    media: mediaTypeNames(),
    spdx: spdxIds(),
    scheme: schemeNames(),
    whatwg: WHATWG_LIST.slice(),
    w3c: w3cNames(),
    methods: sortedKeys(METHOD_OBJECT),
    langs: LANG_LIST.slice(),
    scripts: SCRIPT_LIST.slice(),
    blocks: sortedKeys(UNICODE_BLOCK_OBJECT),
    wellknown: sortedKeys(WELLKNOWN_OBJECT),
    rels: relNames(),
    protoBits,
    httpBits,
  };
  return _closed;
}


/** Cities in ISO2_TAB row order. Country names live in iso3166 (codec); leftovers in CAPITAL_EXTRA. */
export const CAPITAL_CITY_BLOB = `Georgetown
Andorra la Vella
Abu Dhabi
Kabul
St. John's
The Valley
Tirana
Yerevan
Luanda
Buenos Aires
Pago Pago
Vienna
Canberra
Oranjestad
Mariehamn
Baku
Sarajevo
Bridgetown
Dhaka
Brussels
Ouagadougou
Sofia
Manama
Gitega
Cotonou
Gustavia
Hamilton
Bandar Seri Begawan
La Paz
Brasilia
Nassau
Thimphu
Gaborone
Minsk
Belmopan
Ottawa
West Island
Kinshasa
Bangui
Brazzaville
Bern
Yamoussoukro
Avarua
Santiago
Yaounde
Beijing
Bogota
San Jose
Havana
Praia
Willemstad
Flying Fish Cove
Nicosia
Prague
Berlin
Djibouti
Copenhagen
Roseau
Santo Domingo
Algiers
Quito
Tallinn
Cairo
Laayoune
Asmara
Madrid
Addis Ababa
Helsinki
Suva
Stanley
Palikir
Tórshavn
Paris
Libreville
London
St. George's
Tbilisi
St. Peter Port
Accra
Gibraltar
Nuuk
Banjul
Conakry
Ciudad de la Paz
Athens
Guatemala City
Hagatna
Bissau
Georgetown
Tegucigalpa
Zagreb
Port-au-Prince
Budapest
Jakarta
Dublin
Jerusalem
Douglas
New Delhi
London
Baghdad
Tehran
Reykjavik
Rome
St. Helier
Kingston
Amman
Tokyo
Nairobi
Bishkek
Phnom Penh
South Tarawa
Moroni
Basseterre
Pyongyang
Seoul
Kuwait City
George Town
Astana
Vientiane
Beirut
Castries
Vaduz
Colombo
Monrovia
Maseru
Vilnius
Luxembourg
Riga
Tripoli
Rabat
Monaco
Chisinau
Podgorica
Marigot
Antananarivo
Majuro
Skopje
Bamako
Naypyidaw
Ulaanbaatar
Saipan
Nouakchott
Brades
Valletta
Port Louis
Male
Lilongwe
Mexico City
Kuala Lumpur
Maputo
Windhoek
Noumea
Niamey
Kingston
Abuja
Managua
Amsterdam
Oslo
Kathmandu
Yaren
Alofi
Wellington
Muscat
Panama City
Lima
Papeete
Port Moresby
Manila
Islamabad
Warsaw
Saint-Pierre
Adamstown
San Juan
Lisbon
Ngerulmud
Asuncion
Doha
Bucharest
Belgrade
Moscow
Kigali
Riyadh
Honiara
Victoria
Khartoum
Stockholm
Singapore
Jamestown
Ljubljana
Bratislava
Freetown
San Marino
Dakar
Mogadishu
Paramaribo
Juba
São Tomé
San Salvador
Philipsburg
Damascus
Lobamba
Edinburgh of the Seven Seas
Cockburn Town
N'Djamena
Lome
Bangkok
Dushanbe
Atafu
Dili
Ashgabat
Tunis
Nuku'alofa
Ankara
Port of Spain
Funafuti
Taipei
Dodoma
Kyiv
Kampala
Washington
Montevideo
Tashkent
Vatican City
Kingstown
Caracas
Road Town
Charlotte Amalie
Hanoi
Port Vila
Mata Utu
Apia
Pristina
Aden
Bloemfontein
Lusaka
Harare`;

export const CAPITAL_EXTRA: Record<string, string> = {
  "Akrotiri and Dhekelia": "Episkopi Cantonment",
  "atoll": "Nukunonu",
  "suburb": "Sri Jayawardenepura Kotte",
  "Somaliland": "Hargeisa",
  "British Antarctic Territory": "Rothera",
  "Abkhazia": "Sukhumi",
  "Transnistria": "Tiraspol",
  "South Ossetia": "Tskhinvali",
  "Papua": "Port Moresby",
  "Vatican": "Vatican City",
};

function buildCapitalOf(): Record<string, string> {
  const out: Record<string, string> = {};
  const cities = CAPITAL_CITY_BLOB.split("\n");
  const lines = ISO2_TAB.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i]!.slice(3);
    const city = cities[i];
    if (name && city) out[name] = city;
  }
  for (const [k, v] of Object.entries(CAPITAL_EXTRA)) out[k] = v;
  return out;
}

/** Country → capital. Derived from CAPITAL_CITY_BLOB + CAPITAL_EXTRA + ISO2_TAB. */
export const CAPITAL_OF: Record<string, string> = buildCapitalOf();

export function capitalOf(country: string): string | undefined {
  const t = country.trim();
  if (Object.prototype.hasOwnProperty.call(CAPITAL_OF, t)) return CAPITAL_OF[t];
  const hit = Object.entries(CAPITAL_OF).find(([k]) => k.toLowerCase() === t.toLowerCase());
  return hit?.[1];
}

export function capitalTriples(): { s: string; p: "capital"; o: string; e: string }[] {
  const seen = new Set<string>();
  const out: { s: string; p: "capital"; o: string; e: string }[] = [];
  for (const [s, o] of Object.entries(CAPITAL_OF)) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push({ s, p: "capital", o, e: `capital of ${s} is ${o}` });
  }
  return out;
}
