# D1: where to host Eden — cloud providers priced per GB of RAM

Status: desk research, 2026-11-11. No accounts created, no paid calls. Every price below was read on 2026-11-11
unless marked otherwise; prices move (several providers repriced in 2026) and **must be re-checked at signup**.
Currency: Hetzner and OVH dedicated prices are in EUR and converted at the ECB reference rate of 2026-11-11,
**1 EUR = 1.1127 USD** (https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/eurofxref-graph-usd.en.html).
All prices exclude VAT. A month is 730 hours. "Unverified" marks any figure not read on the provider's own page or
price API in this session, with what it rests on.

## In plain words

- **RAM is the bill.** Eden holds 1-4 MB per user and is CPU-light, so the figure that matters is dollars per GB of
  RAM per month. It spans 8x across providers: about **$1.0-1.5/GB** (Hetzner dedicated, Oracle Ampere A1) against
  **$5-7/GB** at AWS, GCP and DigitalOcean.
- **The 2026 RAM shortage changed the cheap end.** Hetzner raised prices twice (1 April, 15 June 2026). Its cheap
  cloud lines (CX x86 and CAX ARM) have shown "not available" since a capacity notice of 26 June 2026. Its in-stock
  cloud lines (CPX, CCX) now cost $3.9-6/GB, about what DigitalOcean charges. Hetzner **dedicated** servers are still
  the cheapest RAM measured (about $1.0-1.4/GB). OVHcloud raised dedicated-server prices from September 2026.
- **Oracle paid A1 is the cheapest RAM you can rent by the hour** ($1.095/GB-month plus $7.30 per ARM core). The
  Always Free A1 allowance is now 2 OCPU / 12 GB (verified on Oracle's docs). Launches often fail with "out of host
  capacity" (reported, mostly free tier).
- **Object storage cost is driven by request count, not bytes.** At 100k users writing a 2 MB blob every 30 minutes,
  that is 144M PUTs a month: about $720 at S3/GCS/Tigris, $648 at R2, $49 at Oracle, $0 at Hetzner, OVH, Vultr
  and DigitalOcean (no request fees listed). Stored bytes (about 200-300 GB) cost $3-7 a month anywhere.
  Writing a blob only when the user changed would cut this further.
- **Recommendation (detail at the end):** first box on a **Hetzner dedicated AX** server (fallback: **Oracle paid
  A1**); fleet on **Hetzner dedicated** in the EU with **Oracle A1** for US regions and as the second source.

## The workload, priced

One box per site, one Bun process per core behind a router, sticky by user hash. Sizing used below:

| Users   | RAM held at 4 MB/user | Box needed (with headroom and runtime) | Blob PUTs/month (48/day/user) | Blob bytes at 2 MB |
| ------- | --------------------- | -------------------------------------- | ----------------------------- | ------------------ |
| 1,000   | 4 GB                  | 4 vCPU / 8-16 GB                       | 1.44M                         | 2 GB               |
| 10,000  | 40 GB                 | 1-2 boxes of 64 GB                     | 14.4M                         | 20 GB              |
| 100,000 | 400 GB                | 4-8 boxes of 64-128 GB, plus a spare   | 144M                          | 200 GB             |

Bandwidth is small JSON; even 100k users at a few MB per user per day stays under the included transfer of every
provider below except AWS and GCP, which include almost none.

## Compute: representative instances and $/GB-RAM

Method: for a bundled VPS the whole monthly price is divided once by GB of RAM and once by vCPU (both columns charge
the full price, so they are not additive). Oracle and GCP price RAM and CPU separately; their component prices are
given in the provider sections.

| Provider          | Instance                         | Arch   | vCPU / RAM    | $/month                 | $/GB-RAM      | $/vCPU          | Orderable 2026-11-11     |
| ----------------- | -------------------------------- | ------ | ------------- | ----------------------- | ------------- | --------------- | ------------------------ |
| Hetzner cloud     | CAX21                            | ARM    | 4 / 8         | 12.23 (€10.99)          | 1.53          | 3.06            | **No** ("not available") |
| Hetzner cloud     | CAX41                            | ARM    | 16 / 32       | 46.17 (€41.49)          | 1.44          | 2.89            | **No**                   |
| Hetzner cloud     | CX33                             | x86    | 4 / 8         | 10.00 (€8.99)           | 1.25          | 2.50            | **No**                   |
| Hetzner cloud     | CX53                             | x86    | 16 / 32       | 33.37 (€29.99)          | 1.04          | 2.09            | **No**                   |
| Hetzner cloud     | CPX32 HEL1                       | x86    | 4 / 8         | 33.93 (€30.49)          | 4.24          | 8.48            | Yes (see note)           |
| Hetzner cloud     | CPX62 HEL1                       | x86    | 16 / 32       | 123.50 (€110.99)        | 3.86          | 7.72            | Yes (see note)           |
| Hetzner cloud     | CPX31 US                         | x86    | 4 / 8         | 70.09 (€62.99)          | 8.76          | 17.52           | Yes (see note)           |
| Hetzner cloud     | CCX23 HEL1 (dedicated vCPU)      | x86    | 4 / 16        | 81.77 (€73.49)          | 5.11          | 20.44           | Yes (see note)           |
| Hetzner dedicated | AX41 (Ryzen 5 3600)              | x86    | 6c/12t / 64   | 65.65 (€59)             | 1.03          | 5.47 per thread | Yes, €0 setup            |
| Hetzner dedicated | AX42 (Ryzen 7 PRO 8700GE)        | x86    | 8c/16t / 64   | 87.90 (€79)             | 1.37          | 5.49 per thread | Yes, €49 setup           |
| Hetzner dedicated | AX102 (Ryzen 9 7950X3D)          | x86    | 16c/32t / 128 | 176.92 (€159)           | 1.38          | 5.53 per thread | Yes, €129 setup          |
| Hetzner dedicated | AX162 (EPYC 9454P), top of range | x86    | 48c/96t / 512 | 683.20 (€614)           | 1.33          | 7.12 per thread | Yes, €304 setup          |
| Oracle            | A1.Flex 4 OCPU / 24 GB           | ARM    | 4 / 24        | 55.48                   | 2.31          | 13.87           | Capacity-dependent       |
| Oracle            | A1.Flex 4 OCPU / 64 GB           | ARM    | 4 / 64        | 99.28                   | 1.55          | 24.82           | Capacity-dependent       |
| Oracle            | E5.Flex 2 OCPU / 16 GB           | x86    | 4 / 16        | 67.16                   | 4.20          | 16.79           | Yes                      |
| Oracle            | E4.Flex 2 OCPU / 16 GB           | x86    | 4 / 16        | 54.02                   | 3.38          | 13.50           | Yes                      |
| OVHcloud          | b3-16 (12-month plan)            | x86    | 4 / 16        | 74.96 (hourly: 88.18)   | 4.68 (5.51)   | 18.74           | Yes                      |
| OVHcloud          | r3-64 (12-month plan)            | x86    | 8 / 64        | 193.91 (hourly: 228.12) | 3.03 (3.56)   | 24.24           | Yes                      |
| DigitalOcean      | Basic 4 vCPU / 8 GiB             | x86    | 4 / 8         | 48.00                   | 6.00          | 12.00           | Yes                      |
| DigitalOcean      | Memory-Optimized 4 vCPU / 32 GiB | x86    | 4 / 32        | 168.00                  | 5.25          | 42.00           | Yes                      |
| Vultr             | vc2-4c-8gb (Cloud Compute)       | x86    | 4 / 8         | 40.00                   | 5.00          | 10.00           | Yes (31 locations)       |
| Vultr             | vx1-m-4c-32gb (VX1 memory)       | x86    | 4 / 32        | 116.80                  | 3.65          | 29.20           | Yes (9 locations)        |
| AWS us-east-1     | t4g.xlarge (Graviton2)           | ARM    | 4 / 16        | 98.11                   | 6.13          | 24.53           | Yes                      |
| AWS us-east-1     | m7g.xlarge                       | ARM    | 4 / 16        | 119.14                  | 7.45          | 29.78           | Yes                      |
| AWS us-east-1     | r7g.xlarge                       | ARM    | 4 / 32        | 156.37                  | 4.89          | 39.09           | Yes                      |
| AWS us-east-1     | r8g.xlarge (Graviton4)           | ARM    | 4 / 32        | 172.02                  | 5.38          | 43.00           | Yes                      |
| AWS eu-central-1  | r8g.xlarge                       | ARM    | 4 / 32        | 207.50                  | 6.48          | 51.87           | Yes                      |
| AWS us-east-1     | r7i.xlarge                       | x86    | 4 / 32        | 193.16                  | 6.04          | 48.29           | Yes                      |
| GCP us-central1   | t2a-standard-4 (Tau T2A)         | ARM    | 4 / 16        | 112.42                  | 7.03          | 28.11           | Yes (few regions)        |
| GCP us-central1   | c4a-highmem-4 (Axion)            | ARM    | 4 / 32        | 172.10                  | 5.38          | 43.03           | Yes                      |
| GCP us-central1   | e2-highmem-4                     | x86    | 4 / 32        | 131.98                  | 4.12          | 33.00           | Yes                      |
| Fly.io            | marginal RAM above a preset      | either | per GB        | 6.00 per GB             | 6.00 marginal | n/a             | Yes                      |

Note on Hetzner "Yes": the CPX/CCX product pages fetched on 2026-11-11 also showed "currently unavailable" next to
every Create button, which may be a page artefact or real; only CX/CAX are confirmed unorderable by several
independent reports (below). Treat all Hetzner cloud stock as uncertain until tried in the console.

## Provider notes

### Hetzner (cloud and dedicated) — https://www.hetzner.com/cloud/ (read 2026-11-11)

- **Pricing pages:** cost-optimized CX/CAX https://www.hetzner.com/cloud/cost-optimized/, CPX
  https://www.hetzner.com/cloud/regular-performance/, CCX https://www.hetzner.com/cloud/general-purpose/,
  dedicated https://www.hetzner.com/dedicated-rootserver/matrix-ax/. Locations: EU NBG1, FSN1, HEL1; US ASH1
  (Ashburn), HIL1 (Hillsboro); SIN1. The cost-optimized page shows one price per plan with no US column; CAX being
  EU-only is **unverified** (rests on earlier knowledge of the product). US CPX prices are about 2x HEL1. Dedicated
  AX servers are not listed for US locations on the matrix page (EU only, **unverified** beyond that page).
- **Traffic:** cloud 20 TB included in EU (US 1-5 TB depending on plan); overage €1.00 per TB in EU and US, €7.40
  per TB in Singapore (the page renders it "per hour per TB", read as per TB). Dedicated AX: unlimited traffic on a
  1 Gbit/s port.
- **Object storage** (https://www.hetzner.com/storage/object-storage/): S3-compatible; €6.49/month base includes
  1 TB stored and 1 TB egress; then €0.0087 per TB-hour (about €6.35 per TB-month) and €1 per TB egress. **No
  request fees**; ingress and traffic inside eu-central free. Objects under 64 KB billed as 64 KB. EU only (FSN1,
  NBG1, HEL1). Limits: 100 buckets, 100 TB and 50M objects per bucket.
- **Load balancer** (https://www.hetzner.com/cloud/load-balancer/): LB11 €7.49 ($8.33), LB21 €21.49, LB31 €42.99 per
  month. Cloud only; dedicated servers need their own router or a cloud LB over vSwitch.
- **2026 price and stock:** press room (https://www.hetzner.com/pressroom/) lists a price adjustment effective
  1 April 2026 and a "standardization and price adjustment" of all cloud and dedicated plans effective 15 June 2026
  (new orders and rescales; existing servers keep their price, per third-party reports). Third-party tallies put
  June increases at +30-38% for CX/CAX and +113-176% for CPX/CCX (**unverified**, e.g.
  https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/). Hetzner's status page
  (https://status.hetzner.com/) carries "Limited availability of cloud instances" since 2026-06-26, still open. All
  eight CX/CAX plans read "not available" on 2026-11-11 (verified on the product page); reports date this from
  June-October 2026 (https://stackvaluelab.com/hetzner-cx-cax-unavailable/, **unverified**). On 2026-11-10 Hetzner
  cut CPX/CCX prices in Helsinki by 15% to steer demand away from German sites with power-grid limits
  (https://www.hetzner.com/pressroom/price-reduction-cloud-servers-in-helsinki-now-15-percent-cheaper/).
- **Account risk:** Hetzner is known for strict signup identity checks and fast abuse-driven suspensions
  (**unverified**, community reports; not researched further).
- **Reliability:** status page shows no 2025 incidents listed and only resolved partial incidents in November 2026
  (console fault 5 Nov; FSN1 object storage degraded 6 and 9 Nov; router maintenance 11 Nov). Dedicated pages state
  "network availability of at least 99.9%". No cloud compute SLA was found (**unverified**). Support is ticket/email
  only (**unverified**).

### Oracle Cloud (OCI)

- **Prices** from Oracle's public price API, read 2026-11-11
  (https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD; the HTML list at
  https://www.oracle.com/cloud/price-list/ blocks automated fetches). Per month: A1 (Ampere Altra, 1 OCPU = 1 vCPU)
  $7.30 per OCPU and **$1.095 per GB RAM**; A2 $10.22 per OCPU and $1.46 per GB; A4 $10.07 per OCPU and $1.97 per
  GB; E4 $18.25 per OCPU ($9.13 per vCPU) and $1.095 per GB; E5 and E6 $21.90 per OCPU ($10.95 per vCPU) and $1.46
  per GB. 1 x86 OCPU = 2 vCPUs (Oracle's note on the price list). A2 OCPU-to-vCPU ratio **unverified**.
- **Always Free:** Oracle's docs (https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm,
  read 2026-11-11) now say 1,500 OCPU-hours and 9,000 GB-hours per month, "equivalent to 2 OCPUs and 12 GB" —
  **the cut from 4/24 is verified**. Its date is not on the page: InfoQ says 15 June 2026, others say enforcement
  from 18 August 2026 with over-allowance instances terminated (https://linuxiac.com/oracle-quietly-cuts-free-tier-ampere-a1-resources-in-half/,
  **unverified**). Oracle's price API still shows the old 3,000 / 18,000 free tiers on the A1 SKUs, so the two
  primary sources disagree; check in the console. Idle Always Free instances may be reclaimed (7 days with p95 CPU,
  network and, for A1, memory all under 20%), per the same docs. Free tier also gives 10 TB egress, 20 GB object
  storage, 50k requests and one 10 Mbps flexible LB.
- **Capacity:** "Out of host capacity" on A1 launches is widely reported in 2026 (Tokyo, Ashburn, Frankfurt,
  Johannesburg), mostly for free accounts (https://community.oracle.com/customerconnect/discussions/tagged/arm,
  **unverified**). Whether paid A1 hits the same wall in a given region is **unverified**; plan to fall back to E4/E5
  in the same region. Free-account reclamation and termination risk is real; a paid (pay-as-you-go) account is the
  only basis for production.
- **Traffic:** first 10 TB/month egress free (NA/EU), then $0.0085/GB.
- **Object storage:** S3-compatible API; $0.0255/GB-month after 10 GB free; requests $0.0034 per 10,000 after 50k free.
- **Load balancer:** flexible LB $0.0113/hour base ($8.25/month) plus $0.0001 per Mbps-hour (about $0.073 per
  Mbps-month); first LB (10 Mbps) free.
- **Regions:** EU (Frankfurt, Amsterdam, London, Paris, Madrid, Milan, Stockholm, Zurich, Marseille) and US (Ashburn,
  Phoenix, San Jose, Chicago) — **unverified** list from earlier knowledge; confirm A1 availability per region.
- **SLA:** the SLA page blocked automated fetch; Oracle advertises a compute availability SLA (99.95% is the commonly
  quoted figure, **unverified**). No major 2025-2026 OCI outage surfaced in searches.

### OVHcloud — https://www.ovhcloud.com/en/public-cloud/prices/ (World site, USD, read 2026-11-11)

- **Instances:** b3-16 (4 vCore / 16 GB) $0.1208/hour or $74.96/month on a 12-month plan; r3-32 (4 / 32)
  $0.1563/hour or $96.98; r3-64 (8 / 64) $0.3125/hour or $193.91. From 1 October 2026, Gen3 instances bill local
  storage and the IP address separately (€0.000146 per GB-hour; €0.0027 per hour for the IP, about €1.97/month), and
  the 1-, 6- and 24-month saving plans are dropped (https://infoq.com/news/2026/08/ovhcloud-memory-price-rise);
  add roughly $6 (50 GB NVMe) plus $2 (IP) per box. No ARM public-cloud instances found.
- **Traffic:** outbound public traffic included in EU and US regions (only APAC metered).
- **Object storage:** S3-compatible; Standard 3-AZ $0.0157/GiB-month (first 50 TiB), one-zone $0.0081; **ingress,
  egress and API requests free**.
- **Load balancer:** S $6.94/month (200 Mbit/s), M $17.37, L $46.21, XL $168.19.
- **2026:** dedicated-server prices up 40-87% on new orders from September 2026; the CEO said RAM cost rose sixfold
  in the year to June 2026 and the shortage may last to 2028 (InfoQ, techzine; **unverified** beyond press). Public
  cloud b3/r3 prices above are post-change as read.
- **Regions:** EU (Gravelines, Roubaix, Strasbourg, Frankfurt, Warsaw, London, Paris 3-AZ) and US (Virginia, Oregon,
  via the separate us.ovhcloud.com entity) — **unverified** list. OVH's 2021 Strasbourg fire remains the reference
  case for keeping blobs in another site.

### DigitalOcean — https://www.digitalocean.com/pricing/droplets (read 2026-11-11)

- Basic 4 vCPU / 8 GiB $48 (5,000 GiB transfer); Memory-Optimized 2 / 16 GiB $84, 4 / 32 GiB $168; no ARM.
- Transfer pooled per team; overage $0.01/GiB, no regional variation (https://docs.digitalocean.com/platform/billing/bandwidth/).
- Spaces (S3-compatible): $5/month includes 250 GiB and 1 TiB egress; $0.02/GiB storage, $0.01/GiB egress
  (https://www.digitalocean.com/pricing/spaces-object-storage). Request fees not listed (**unverified** that none).
- Load balancer: from $12/month per node (https://www.digitalocean.com/pricing/load-balancers).
- No 2026 general price rise found. SLA 99.99% for Droplets (**unverified**, earlier knowledge). Regions NYC, SFO,
  TOR, AMS, FRA, LON and others.

### Vultr — public plans API https://api.vultr.com/v2/plans (read 2026-11-11; www.vultr.com blocks fetches)

- vc2-4c-8gb $40 (4 TB transfer, 31 locations); vhp-4c-8gb $48; vx1-m-4c-32gb $116.80 (6 TB, 9 locations); no ARM
  plans in the API listing.
- Overage $0.01/GB (**unverified** for compute; the docs state $10/TB for object storage).
- Object storage (https://docs.vultr.com/support/products/storage/pricing-and-billing): Standard $18/month includes
  1,000 GB and 1 TB egress; then $0.018/GB-month and $10/TB. S3-compatible; request fees not listed.
- Load balancer from $10/month (Vultr billing doc via search, https://docs.vultr.com/support/platform/billing/how-are-vultr-load-balancers-priced;
  **unverified** on the page itself). No 2026 price rise found. SLA "100%" network (**unverified**).

### AWS — EC2 price map published 2026-11-10 (https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20(N.%20Virginia)/Linux/index.json)

- On-demand per hour, us-east-1 (Frankfurt): t4g.xlarge $0.1344 ($0.1536); m7g.xlarge $0.1632 ($0.1955); r7g.xlarge
  $0.2142 ($0.2584); r8g.xlarge $0.23564 ($0.28424); r8g.2xlarge $0.47128. Savings Plans/RIs cut these by roughly
  30-60% (**unverified** here). t4g is burstable; fine for a CPU-light server only while under its CPU credits.
- Egress: first 100 GB/month free (all services), then $0.09/GB for the next 10 TB, $0.085, $0.07, $0.05
  (AWS data-transfer price map).
- S3 Standard (us-east-1): $0.023/GB-month first 50 TB; PUT $0.005 per 1,000; GET $0.0004 per 1,000 (S3 price map).
  Same-region EC2-to-S3 transfer free.
- ALB/NLB: $0.0225/hour ($16.43/month) plus $0.008 per LCU-hour / $0.006 per NLCU-hour
  (https://aws.amazon.com/elasticloadbalancing/pricing/).
- SLA: 99.99% per region across 2+ AZs, 99.5% per instance (https://aws.amazon.com/compute/sla/). Outages:
  us-east-1 DNS failure of October 2025 (about 15 hours); further 2026 incidents reported by newsletters
  (**unverified**). Only a GPU capacity product saw a 2026 price rise (**unverified**).

### GCP — https://cloud.google.com/products/compute/pricing/general-purpose (us-central1, read 2026-11-11)

- Per hour on demand: t2a-standard-4 $0.154; c4a-standard-4 $0.1796; c4a-highmem-4 $0.23576; e2-standard-4 $0.1340;
  e2-highmem-4 $0.1808. The page's discount columns show 1-year and 3-year commitments about 28% and 46% lower for
  C4A and E2.
- Egress (premium tier, to NA/EU, https://cloud.google.com/vpc/network-pricing): $0.12/GiB first TiB, $0.11 to
  10 TiB, then $0.08-0.085; 200 GiB/month free tier listed for standard tier.
- Cloud Storage (https://cloud.google.com/storage/pricing): Standard us-central1 $0.020/GiB-month; Class A $0.005
  and Class B $0.0004 per 1,000. S3-style XML API with HMAC keys exists (**unverified** here).
- Load balancer (https://cloud.google.com/load-balancing/pricing): $0.025/hour for the first 5 forwarding rules
  ($18.25/month) plus $0.008/GiB processed.
- Outages: June 2025 multi-hour global incident (**unverified**, press). EU and US regions plentiful; T2A only in a
  few regions (**unverified**).

### Fly.io — https://docs.fly.io/about/pricing (read 2026-11-11)

- Presets: shared-cpu-2x / 2 GB $13.39; performance-1x / 2 GB $33; performance-2x / 4 GB $66 ($16.50/GB). Extra RAM
  $6/GB-month. Reservations give 40% off CPU and RAM. Egress $0.02/GB (NA/EU). Built-in proxy load balancing at no
  listed charge (**unverified**). Object storage via Tigris: $0.02/GB-month, $0.005 per 1,000 Class A, no egress
  (Tigris docs via search, **unverified**). Support $29-$199/month. One newsletter counts 13 Fly incidents in 12
  months (**unverified**). No SLA below enterprise (**unverified**).

### Cloudflare R2 (cross-provider) — https://developers.cloudflare.com/r2/pricing/ (read 2026-11-11)

- $0.015/GB-month; Class A (PUT) $4.50 per million; Class B (GET) $0.36 per million; **zero egress**. Free tier
  10 GB, 1M Class A, 10M Class B per month. S3-compatible. Cloudflare had global outages on 18 November and
  5 December 2025 (**unverified**, press).

Akamai/Linode and Scaleway were not priced: at list prices known before this session both sit in the $4-6/GB band
(**unverified**) and would not change the recommendation.

## Object storage for Eden's blobs

**Correction (the parent session, from the code):** a user's blob is written to the store when they are frozen
compact after 30 minutes idle, at a release and at a shutdown, not every 30 minutes: about one write per idle
period, and a thaw does not delete the store's copy (D992). For a heavy user (about 50 requests a day) that is on
the order of 5-10 writes a day, not 48 **[EST]**; the PUT columns below assume 48 a day and so overstate request
costs about 5-10x. docs/COST-MODEL.md, "Hosting", uses the lower figure.

| Store               | $/GB-month                            | PUT (Class A)                | Egress                   | S3 API   | PUT cost at 10k / 100k users |
| ------------------- | ------------------------------------- | ---------------------------- | ------------------------ | -------- | ---------------------------- |
| Hetzner             | €6.49 base incl. 1 TB, then ~€6.35/TB | free                         | 1 TB incl., then €1/TB   | yes      | $0 / $0 (base $7.22)         |
| OVH Standard 3-AZ   | 0.0157                                | free                         | free                     | yes      | $0 / $0                      |
| Oracle              | 0.0255 (10 GB free)                   | $0.0034 / 10k                | 10 TB free, then $0.0085 | yes      | $5 / $49                     |
| DigitalOcean Spaces | $5 incl. 250 GiB, then 0.02           | not listed                   | 1 TiB incl., then $0.01  | yes      | $0 / $0 (**unverified**)     |
| Vultr Standard      | $18 incl. 1 TB, then 0.018            | not listed                   | 1 TB incl., then $0.01   | yes      | $0 / $0 (**unverified**)     |
| Cloudflare R2       | 0.015                                 | $4.50 / M                    | free                     | yes      | $65 / $648                   |
| AWS S3 Standard     | 0.023                                 | $0.005 / 1k                  | $0.09 (free same-region) | native   | $72 / $720                   |
| GCS Standard        | 0.020                                 | $0.005 / 1k                  | $0.12 (free same-region) | XML/HMAC | $72 / $720                   |
| Tigris              | 0.02 (**unverified**)                 | $0.005 / 1k (**unverified**) | free                     | yes      | $72 / $720                   |

The PUT count (48 a day per idle user) costs 10-100x more than the bytes at per-request stores. Two levers: keep the
store on a provider with free requests (Hetzner, OVH), or write only when a user's state changed since the last write.
Failover and rebalance reads are rare and cheap everywhere. Hetzner's store is EU-only, so a US fleet on another
provider would pay cross-provider egress to read it; R2 avoids that at a request cost.

## Recommendation

Weights: $/GB-RAM first, then reliability, object storage cost, then stock risk.

**(a) First box, up to ~1,000 heavy users (4-8 GB held, 16 GB box).**

- **Primary: Hetzner dedicated AX41/AX42** (64 GB, €59-79, $66-88/month, $1.0-1.4/GB; €0-49 setup), with blobs in
  Hetzner Object Storage (€6.49). Far more RAM than needed at the price of a 16 GB VPS elsewhere; no ARM needed
  since the image builds for amd64. If an hourly, cancel-any-time box is wanted instead, a Hetzner CPX32 in HEL1
  (€30.49) is the in-stock cloud option.
- **Fallback: Oracle paid A1.Flex**, e.g. 4 OCPU / 24 GB at $55.48/month (or inside the free 2 OCPU / 12 GB for a
  pilot), Oracle Object Storage, first LB free. Retry or drop to E4.Flex ($54.02 for 4 vCPU / 16 GB) if A1 is out of
  capacity. Gives a US region, which Hetzner dedicated lacks.

**(b) Fleet, 10k-100k users (40-400 GB held).**

- **Primary: Hetzner dedicated in the EU** (AX102 128 GB at $177/month, or AX162 up to 512 GB): 400 GB plus a spare
  is about five AX102s, roughly $885/month ($1.38/GB), with Hetzner Object Storage at no request cost. The router
  runs on the boxes or behind a cloud LB11 (€7.49).
- **Fallback and US regions: Oracle A1.Flex** at about $1.10/GB RAM plus cores; 400 GB with 64 OCPUs is about
  $905/month, with blobs in Oracle Object Storage (~$49/month of PUTs at 100k users). Use E4/E5 where A1 is short.
- Hyperscalers cost 4-5x per GB (AWS r8g $5.38, GCP c4a-highmem $5.38, e2-highmem $4.12) plus per-request blob
  costs; worth it only if a customer requires them. Vultr VX1 memory ($3.65/GB) and OVH r3 ($3.03/GB on a 12-month
  plan, free object-storage requests) are the mid-priced options if both Hetzner and Oracle fail on stock.

Risks to check before committing: Hetzner cloud stock and any further 2026 repricing; Hetzner dedicated is EU-only
and not hourly; Oracle A1 capacity per region and Oracle's account-review behaviour on new paid tenancies; OVH Gen3
billing change of 1 October 2026. All prices: re-check at signup.
