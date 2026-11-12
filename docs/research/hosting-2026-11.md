# Hosting Eden in production, November 2026: RAM per dollar, three stages, compliance, risks

Status: desk research, 2026-11-12. No account created, nothing ordered, no paid call. It builds on
[d1-providers.md](d1-providers.md) (prices read the day before) and on DEPLOY.md §6 (users per box) and
[s1-scale-1m.md](s1-scale-1m.md) (the 1M-user design). Every price below was read on 2026-11-12 from the page or
public price API named beside it, unless marked **unverified** (with what it rests on) or **[d1, 2026-11-11]** (read
the day before by d1-providers.md and not re-read here). **[EST]** marks arithmetic on measured inputs. All prices
exclude VAT. A month is 730 hours. EUR is converted at the ECB reference rate of 2026-11-12, **1 EUR = 1.1081 USD**
(https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml). Users per box are `deploy/scripts/sizing.py`'s
formula on DEPLOY.md §6's measured **4.71 MB a heavy user at the peak hour** (8.43 MB with a model key's card state).

## In plain words

1. **Cheapest RAM you can actually order today: Hetzner dedicated AX in the EU** (AX41 64 GB at €59, $1.02/GB, no
   setup fee; AX102 128 GB from €159, $1.38/GB; AX162 512 GB at €614, $1.33/GB). OVHcloud's older dedicated lines
   (Kimsufi, So you Start, Rise) list RAM at a third to half of that ($0.31-0.82/GB), but most of their 128-256 GB
   configurations show "unavailable" in every European datacentre today. **In the US, Oracle A1 (ARM)** at $1.55/GB
   for a memory-heavy shape is the cheapest hourly RAM; netcup's Manassas root servers and Vultr bare metal are the
   x86 alternatives at $2.15-2.8/GB. Hyperscalers are $4.2-6.5/GB; Fly.io, Railway and Render $6-14/GB.
2. **Every Hetzner cloud line (CX, CAX, CPX, CCX) reads "currently unavailable" today**, in every location, not only
   the cheap CX/CAX lines DEPLOY.md mentions. Hetzner cloud is not a dependable source of machines this month.
3. **Stages** (heavy users at the peak hour; full tables in §2):
   - **Pilot:** one Hetzner AX41 (64 GB, holds about 9,964) plus Object Storage for backups: **€65.49 ($72.57) a
     month, €0 setup.** US pilot: one Oracle A1.Flex 4 OCPU / 24 GB, **$55.48**.
   - **10k users:** three AX41 (two hold 19,928, so one may fail) on a free vSwitch, Object Storage as the store,
     routers on two nodes: **€183.49 ($203.33) a month**, $0.020 a user. US: four A1 4 / 24, **about $223**.
   - **1M users:** about 4.7 TB of RAM. 56 AX102 (51 plus 10% spare) **€9,039 ($10,016) a month at the €159 type,
     €14,639 ($16,222) at the €259 type**, plus €7,224 of setup fees once; or 15 AX162 at 512 GB, **€9,345
     ($10,356)**, fewer machines but 80,000 users on each. US: 28 Oracle A1 16 OCPU / 256 GB, **about $11,300 plus
     egress past 10 TB**. About one cent a user a month either way.
4. **Compliance:** EU tenants are served best by the EU dedicated providers (Hetzner, OVH, netcup, Scaleway are all
   EU companies with a GDPR Art. 28 DPA and ISO 27001). None but OVH has a SOC 2 report; a US enterprise buyer's
   questionnaire will ask for one, which Oracle, AWS, GCP, Azure, DigitalOcean, Vultr, Fly.io and Render can supply.
   A provider's certificate covers the datacentre, not Eden: the buyer will also want Eden's own DPA, its subprocessor
   list (the host, OpenRouter and the model providers behind it when a model key is set) and, later, Eden's own SOC 2.
5. **Risks:** Hetzner's identity checks (a second rejection is final), stock (AX42-1 and AX102-1 "several weeks" in
   Germany) and three price changes in 2026; Oracle's A1 capacity, free-tier cuts and account reviews; OVH's thin
   stock; ARM is supported by Bun and Eden's image but never measured on real ARM hardware here, and a 64K-page ARM
   kernel (Oracle Linux's optional `uek64k`) has crashed Bun binaries.

## 1. RAM per dollar

### 1.1 Compute

$/GB divides the whole monthly price by GB of RAM (Eden is memory-bound and CPU-light, DEPLOY.md §6). "Stock" is what
the provider's own page or API said on 2026-11-12.

| Provider | Machine | Arch, cores | RAM | Monthly | $/GB | Setup | Stock 2026-11-12 | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hetzner dedicated | AX41 (Ryzen 5 3600, DDR4, no ECC) | x86, 6c/12t | 64 GB | €59.00 ($65.38) | 1.02 | €0 | not listed on the delivery page (**unverified**) | [ax41](https://www.hetzner.com/dedicated-rootserver/ax41/) |
| Hetzner dedicated | AX42 (Ryzen 7 PRO 8700GE, ECC) | x86, 8c/16t | 64 GB | €79-99 ($87.54-109.70) | 1.37-1.71 | €49 | AX42-1 "several weeks" (DE, FI); AX42-2 minutes in FI | [matrix](https://www.hetzner.com/dedicated-rootserver/matrix-ax/), [ax42](https://www.hetzner.com/dedicated-rootserver/ax42/), [delivery](https://docs.hetzner.com/general/infrastructure-and-availability/order-processing/) |
| Hetzner dedicated | AX102 (Ryzen 9 7950X3D, ECC) | x86, 16c/32t | 128 GB | €159-259 ($176.19-287.00) | 1.38-2.24 | €129 | AX102-1 "several weeks" in DE; -2, -3 minutes | as above, [ax102](https://www.hetzner.com/dedicated-rootserver/ax102/) |
| Hetzner dedicated | AX162 (EPYC 9454P, ECC reg.) | x86, 48c/96t | 128-512 GB | €319-614 ($353.48-680.37) | 1.33 at 512 GB | €304 | -2, -3 minutes; -1, -4 days | as above |
| Hetzner auction | refurbished, varies | x86 | varies | from €75.70 | not captured | €0 | listings did not load | [sb](https://www.hetzner.com/sb/) |
| Hetzner cloud | CX53 / CAX41 (ARM) | 16 vCPU | 32 GB | €29.99 / €41.49 | 1.04 / 1.44 | none | **unavailable**, all 8 CX/CAX plans | [cost-optimized](https://www.hetzner.com/cloud/cost-optimized/) |
| Hetzner cloud | CPX62 HEL1 / NBG1 | 16 vCPU | 32 GB | €110.99 / €130.49 | 3.84 / 4.52 | none | **unavailable**, all CPX plans | [regular-performance](https://www.hetzner.com/cloud/regular-performance/) |
| Hetzner cloud | CCX53 HEL1 / NBG1 / US | 32 dedicated vCPU | 128 GB | €453.49 / €533.99 / €538.99 | 3.93 / 4.62 / 4.67 | none | **unavailable**, all CCX plans | [general-purpose](https://www.hetzner.com/cloud/general-purpose/) |
| OVHcloud dedicated | KS-6 (EPYC 7351P) | x86, 16c | 128 / 256 GB | €38.99 / €70.99 | 0.34 / 0.31 | €0 | 128 GB on HDD in BHS (Canada) only; else unavailable | [eco catalog](https://api.ovh.com/1.0/order/catalog/public/eco?ovhSubsidiary=IE), [availability](https://api.ovh.com/1.0/dedicated/server/datacenter/availabilities?planCode=24sk602) |
| OVHcloud dedicated | KS-7 (EPYC 7451) | x86, 24c | 128 / 256 GB | €61.99 / €93.99 | 0.54 / 0.41 | €0 | 128 GB NVMe in SBG, 256 GB HDD in FRA ("1H-low"); others unknown | as above |
| OVHcloud dedicated | SYS-4 (EPYC 7371) | x86, 16c | 128 / 256 GB | €89.99 / €129.99 | 0.78 / 0.56 | €0 | 128 GB in RBX, WAW; most "unknown" | as above |
| OVHcloud dedicated | RISE-8 (EPYC 7532) | x86, 32c | 256 GB | €189.99 | 0.82 | €0 | unavailable everywhere | as above |
| OVHcloud dedicated | ADVANCE-2 (EPYC 4344P) | x86, 8c | 128 GB | €216.99 | 1.88 | €0 | LON, BHS | as above |
| OVHcloud public cloud | r3-64 / r3-128 (hourly) | x86, 8 / 16 vCPU | 64 / 128 GB | €193.30 / €386.90 | 3.35 | none | yes | [cloud catalog](https://api.ovh.com/1.0/order/catalog/public/cloud?ovhSubsidiary=IE) |
| netcup | VPS 8000 ARM G12.5 (shared vCores) | ARM, 16 | 64 GB | €67.11 (12-month term) | 1.16 | **unverified** | orderable | [arm-server](https://www.netcup.com/en/server/arm-server) |
| netcup | RS 2000 / RS 8000 / RS 16000 G12.5 (dedicated EPYC 9645 cores) | x86, 8 / 16 / 24 | 16 / 64 / 128 GB | €40.70 / €148.42 / €289.46 (12-month) | 2.82 / 2.57 / 2.51 | **unverified** | RS 16000 "request only"; VIE, NUE, **MNZ (Virginia)** | [root-server](https://www.netcup.com/en/server/root-server) |
| Scaleway | Elastic Metal EM-B111X (2x Xeon E5 2620) | x86, 12c | 192 GB | €94.99 | 0.55 | one month's rent on monthly billing | **unverified** | [elastic-metal](https://www.scaleway.com/en/pricing/elastic-metal/) (403 here; via search) |
| Scaleway | POP2-HM-16C-128G | x86, 16 vCPU | 128 GB | €601.52 (€0.824/h) | 5.21 | none | **unverified** | [virtual-instances](https://www.scaleway.com/en/pricing/virtual-instances/) (403 here; via search) |
| Oracle Cloud | A1.Flex 4 OCPU / 24 GB | ARM, 4 | 24 GB | $55.48 | 2.31 | none | capacity-dependent | [price API](https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD) |
| Oracle Cloud | A1.Flex 16 OCPU / 256 GB | ARM, 16 | 256 GB | $397.12 | 1.55 | none | capacity-dependent | as above ($0.01 an OCPU-hour, $0.0015 a GB-hour) |
| Oracle Cloud | E4.Flex 4 OCPU / 64 GB | x86, 8 vCPU | 64 GB | $143.08 | 2.24 | none | yes | as above ($0.025, $0.0015) |
| Oracle Cloud | Always Free A1 | ARM, 2 | 12 GB | $0 | 0 | none | capacity-dependent | [free tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) |
| DigitalOcean | Memory-Optimized 32 / 256 GiB | x86, 4 / 32 | 32 / 256 GiB | $168 / $1,344 | 5.25 | none | yes | [droplets](https://www.digitalocean.com/pricing/droplets) |
| Vultr | VX1 memory vx1-m-16c-128gb | x86, 16 | 128 GB | $467.20 | 3.65 | none | 9 locations | [plans API](https://api.vultr.com/v2/plans) |
| Vultr | bare metal vbm-24c-384gb-amd (EPYC 9254) | x86, 24c | 384 GB | $825 | 2.15 | none | 20 locations | [metal API](https://api.vultr.com/v2/plans-metal) |
| AWS | r7g.xlarge / r8g.xlarge / x8g.xlarge, us-east-1 | ARM, 4 | 32 / 32 / 64 GiB | $156.37 / $172.02 / $285.28 | 4.89 / 5.38 / 4.46 | none | yes | [EC2 price map, published 2026-11-10](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20(N.%20Virginia)/Linux/index.json) |
| AWS | r8g.xlarge, eu-central-1 | ARM, 4 | 32 GiB | $207.50 | 6.48 | none | yes | the Frankfurt map, same path |
| Azure | E4ps v6, eastus / westeurope | ARM, 4 | 32 GiB | $134.32 / $160.60 | 4.20 / 5.02 | none | yes | [retail prices API](https://prices.azure.com/api/retail/prices) |
| GCP | e2-highmem-4, us-central1 | x86, 4 | 32 GB | $131.98 | 4.12 | none | yes | [d1, 2026-11-11] [pricing](https://cloud.google.com/products/compute/pricing/general-purpose) |
| Fly.io | RAM above a CPU preset | either | per GB | $6.00 a GB (40% off with reservations) | 6.00 marginal | none | yes | [pricing](https://docs.fly.io/about/pricing) |
| Railway | per-second usage, 64 GB + 4 vCPU | either | 64 GB | $720 ($10 a GB, $20 a vCPU) | 11.25 | plan $5-20 | yes | [pricing](https://railway.com/pricing) |
| Render | Pro Ultra web service | x86, 8 | 32 GB | $450 | 14.06 | workspace plan | yes | [pricing](https://render.com/pricing) (via search, **unverified**) |

Notes on the table:

- **Hetzner dedicated prices.** The matrix shows a range per model ("4 Types starting from €159.00 … max €259.00" for
  AX102); the single product page quotes the base configuration at €259. Which type costs €159 is not on the page;
  third-party reports describe the cheap types as "-1-LTD", built from cheaper hardware "while stock lasts"
  (https://cloudtally.eu/blog/hetzner-june-2026-price-increase, https://webhosting.today/2026/05/29/hetzner-has-now-raised-prices-three-times-in-2026-this-one-is-different/;
  **unverified**). Plan on the top of each range and treat the bottom as a discount when in stock. Product pages also
  quote an hourly rate (AX41 €0.0945/h): Hetzner bills by the hour up to the monthly price
  (https://docs.hetzner.com/general/billing-and-account-management/billing-at-hetzner/billing-system-hetzner/, read
  through search, **unverified**); the setup fee remains. Hetzner's own price-adjustment page now returns 404; reports
  of a June AX42-1 at €187.30 later cut to €97.30 are **unverified**. Primary IPv4 €1.70 a month
  ([ax102](https://www.hetzner.com/dedicated-rootserver/ax102/)), apparently inside the quoted price (**unverified**).
- **OVHcloud dedicated** prices are the base configuration in the Irish subsidiary's catalogue (EUR, tax separate);
  a RAM upgrade is added (KS-6 256 GB = €38.99 + €32), storage options may change the price. Kimsufi (KS) and So you
  Start (SYS) carry no private network (vRack) and a lighter SLA (**unverified**, earlier knowledge). OVH's US
  datacentres (Vint Hill, Hillsboro) sell through the separate us.ovhcloud.com and were not priced.
- **netcup** shows two figures per plan; only the second is labelled "incl. 19% VAT" and they do not differ by 19%
  (RS 8000: €148.42 and €170.69), so the first is taken as the net price on the 12-month term, **unverified**; one
  third party lists RS 8000 at €124.72 net on that term (https://www.vpsbenchmarks.com/hosters/netcup/plans/rs-8000-g12-5).
  The 24-month term is 26% off. The ARM line is a VPS (shared cores); its locations were not on the page.
- **Scaleway's** pricing pages returned 403 to this session; its public API lists the instance types (including new
  BASIC3, STANDARD3, MEMORY3 families) but returns price 0 without a token
  (https://api.scaleway.com/instance/v1/zones/fr-par-1/products/servers). Both Scaleway figures are from search
  summaries of its pages, **unverified**.

### 1.2 Egress, regions, private network and object storage

| Provider | Egress | Regions for Eden | Private network | S3-compatible store (request fees) | Source |
| --- | --- | --- | --- | --- | --- |
| Hetzner | dedicated: unlimited on the 1 Gbit/s port (not with the 10G add-on, €43/month); cloud: 20-60 TB EU, 0.5-8 TB US/SG, then €1/TB | dedicated: FSN1, HEL1 (EU only; NBG1 not offered for AX); cloud: NBG1, FSN1, HEL1, ASH1, HIL1, SIN1 | vSwitch for dedicated (internal traffic free; up to 100 servers per vSwitch, 5 vSwitches per server; base price not listed); cloud Networks | Object Storage, FSN1/NBG1/HEL1: €6.49/month includes 1 TB stored and 1 TB egress, then €0.0087 per TB-hour (≈€6.35/TB-month) and €1/TB; **no request fees**; 750 requests/s per bucket and per source IP, 100 buckets, 50M objects per bucket | [ax41](https://www.hetzner.com/dedicated-rootserver/ax41/), [vswitch](https://docs.hetzner.com/robot/dedicated-server/network/vswitch/), [add-ons](https://docs.hetzner.com/robot/dedicated-server/dedicated-server-hardware/price-server-addons/), [object storage](https://www.hetzner.com/storage/object-storage/), [limits](https://docs.hetzner.com/storage/object-storage/overview) (via search) |
| OVHcloud | dedicated: unmetered, 1-5 Gbit/s public by plan; public cloud: included in EU/US | EU: GRA, RBX, SBG, FRA, LON, WAW; Canada: BHS; US via us.ovhcloud.com | vRack (Advance, Rise, public cloud; private 25 Gbit/s on Advance-3) | Standard 3-AZ €0.0140/GiB-month, one-zone €0.0073; requests and egress free [d1, 2026-11-11] | [bare-metal prices](https://www.ovhcloud.com/en/bare-metal/prices/), [cloud catalog](https://api.ovh.com/1.0/order/catalog/public/cloud?ovhSubsidiary=IE) |
| netcup | "included" (volume not stated, **unverified**) | Vienna, Nuremberg, Manassas (VA), Singapore | CloudVLAN: 100 Mbit/s free, 1 Gbit/s €10.91, 2.5 Gbit/s €17.23 (period not stated) | none found (**unverified**); use Hetzner's or R2 | [root-server](https://www.netcup.com/en/server/root-server), [extensions](https://netcup.com/en/server/kvm-server-extensions) (via search) |
| Scaleway | instances: included; Elastic Metal: up to 1-10 Gbit/s | Paris, Amsterdam, Warsaw | Private Networks; on Elastic Metal €9.99/month (1 Gbit/s) or €19.99 (10 Gbit/s) | €0.0146/GB-month multi-AZ; requests included; 75 GB egress free, then €0.01/GB (**unverified**, via search) | [storage](https://www.scaleway.com/en/pricing/storage/) |
| Oracle | first 10 TB/month free (NA, EU, UK), then $0.0085/GB | EU and US regions (list **unverified**) | VCN, no charge (**unverified**) | $0.0255/GB-month after 10 GB; $0.0034 per 10,000 requests after 50,000; flexible LB $0.0113/h after the first, first 10 Mbit/s free | [price API](https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD) |
| DigitalOcean | 4-10 TiB a droplet, pooled; $0.01/GiB over [d1] | NYC, SFO, TOR, AMS, FRA, LON and more [d1] | VPC (no charge listed) | Spaces $5 includes 250 GiB and 1 TiB; $0.02/GiB, $0.01/GiB egress; request fees not listed | [droplets](https://www.digitalocean.com/pricing/droplets), [spaces](https://www.digitalocean.com/pricing/spaces-object-storage) |
| Vultr | 5-10 TB a VX1 plan; overage **unverified** | 9 (VX1) to 20 (bare metal) locations, EU and US | VPC (**unverified**) | Standard $18 includes 1,000 GB and 1 TB; $10/TB egress; request fees not listed | [plans API](https://api.vultr.com/v2/plans), [storage](https://docs.vultr.com/support/products/storage/pricing-and-billing) |
| AWS | 100 GB free, then $0.09/GB [d1] | everywhere | VPC | S3 $0.023/GB, PUT $0.005 per 1,000 [d1] | [d1-providers.md](d1-providers.md) |
| Azure, GCP | about $0.09-0.12/GB [d1 for GCP; Azure **unverified**] | everywhere | VNet / VPC | per-request pricing like S3 (**unverified** here) | |
| Fly.io | $0.02/GB NA/EU, $0.04 APAC | 30+ regions | same-region free; cross-region $0.006/GB NA/EU | Tigris at Tigris's list price (not on Fly's page) | [pricing](https://docs.fly.io/about/pricing) |
| Railway | $0.05/GB | **unverified** | private networking (page describes it for sandboxes only) | Buckets $0.015/GB-month, free egress | [pricing](https://railway.com/pricing) |
| Cloudflare R2 (any host) | free | global | n/a | $0.015/GB-month; $4.50 per million writes, $0.36 per million reads; free tier 10 GB, 1M writes, 10M reads | [r2 pricing](https://developers.cloudflare.com/r2/pricing/) |

The store's bill is set by writes, not bytes: about 5-10 writes a heavy user a day **[EST, COST-MODEL.md]**, 2-2.7 MB a
user stored. At 1M users that is about 150-300M writes a month: $0 at Hetzner, OVH and Scaleway, about $50-100 at
Oracle, $675-1,350 at R2, $750-1,500 at S3 **[EST]**. Hetzner's 750 requests a second per bucket caps one bucket at
about 1.9 billion requests a month on average but far less at a rebalance's burst; s1-scale-1m.md already plans a
store split over several buckets.

## 2. Three stages

Users per box (`sizing.py`'s formula: 75% of RAM, 70 MB and 60 MB of model weights a process, router 55 MB; 4.71 MB a
heavy user at the peak hour, 8.43 with a model key):

| Box | Processes | Heavy users, no key | With a model key |
| --- | --- | --- | --- |
| Oracle A1 2 / 12 GB | 2 | 1,845 | 1,031 |
| Oracle A1 4 / 24 GB | 4 | 3,702 | 2,068 |
| netcup RS 2000, 16 GB | 8 | 2,320 | 1,296 |
| 64 GB (AX41, AX42) | 8 | 9,964 | 5,567 |
| 128 GB (AX102) | 16 | 19,939 | 11,140 |
| 256 GB (Oracle A1 16 / 256) | 16 | 40,321 | 22,528 |
| 384 GB (Vultr bare metal) | 48 | 59,841 | 33,434 |
| 512 GB (AX162) | 48 | 80,223 | 44,822 |

### 2.1 Day one: a pilot with a few tenants (up to a few thousand users)

| Choice | Machines | Monthly | Setup | Holds |
| --- | --- | --- | --- | --- |
| **EU, recommended** | 1 x Hetzner AX41, 64 GB, FSN1 or HEL1; Caddy on the box; backups to Hetzner Object Storage | €59.00 + €6.49 = **€65.49 ($72.57)** | €0 | 9,964 (5,567 with a key) |
| EU if AX41 cannot be had | 1 x AX42 (64 GB, ECC) | €79-99 + €6.49 = €85.49-105.49 ($94.73-116.89) | €49 | same |
| **US** | 1 x Oracle A1.Flex 4 OCPU / 24 GB, Ubuntu 24.04 (4K pages); Oracle Object Storage inside its free 10 GB | **$55.48** | none | 3,702 |
| US, x86 | 1 x netcup RS 2000 G12.5 in Manassas (8 dedicated cores, 16 GB), 12-month term; backups to R2's free tier | €40.70 (**$45.10**) | **unverified** | 2,320 |
| Free, not for paying tenants | Oracle Always Free A1 2 / 12 GB | $0 | none | 1,845 |

One box is one failure domain; persistence (D991) and the daily backup make a loss a restore. The AX41's DDR4 has no
ECC; for a pilot that is acceptable, for a fleet use ECC boxes (AX42 and up).

### 2.2 About 10,000 users

Size for one machine failing at the peak hour: N+1.

| Choice | Machines | Monthly | Setup | Per user-month |
| --- | --- | --- | --- | --- |
| **EU, recommended** | 3 x AX41 (two hold 19,928; 11,134 with a key) on one vSwitch; the cluster router on two of them with Caddy, DNS over both; Hetzner Object Storage as the store (about 27 GB) | €177 + €6.49 = **€183.49 ($203.33)** | €0 | $0.020 |
| EU with ECC | 3 x AX42 | €237-297 + €6.49 = €243.49-303.49 ($269.81-336.30) | €147 | $0.027-0.034 |
| **US** | 4 x Oracle A1 4 / 24 (three hold 11,106); Oracle Object Storage (about 2.25M writes and 27 GB: about $1.20); the first load balancer free | $221.92 + ~$1.20 = **about $223** | none | $0.022 |
| US, x86 | 3 x netcup RS 8000 (64 GB) in Manassas | €445.26 ($493.39) | **unverified** | $0.049 |

A Hetzner cloud load balancer (LB11, €7.49 [d1]) can front dedicated servers over the vSwitch, but with every cloud
line unavailable today, DNS over two routers is the dependable choice.

### 2.3 About 1,000,000 users

About 4.7 TB of RAM at the peak hour (8.4 TB with a model key). Spares: 10% (one box in ten may be down). The store
is spread over several buckets (s1-scale-1m.md, Hetzner's 750 requests/s per bucket); two routers run on their own
boxes.

| Choice | Machines | Monthly | Setup (once) | Per user-month |
| --- | --- | --- | --- | --- |
| **EU, recommended: Hetzner AX102** | 51 + 5 spare = 56 x AX102 (128 GB, 19,939 each); 2 x AX41 routers (€118); Object Storage for about 2.7 TB (€6.49 + 1.7 TB x €6.35 = €17.29); one vSwitch (56 + 2 servers, under its 100) | at €159 a box: **€9,039 ($10,016)**; at €259: **€14,639 ($16,222)** | €7,224 | $0.010-0.016 |
| EU, fewer machines: Hetzner AX162 512 GB | 13 + 2 spare = 15 x AX162 (80,223 each); routers and store as above | **€9,345 ($10,356)** | €4,560 | $0.010 |
| EU, cheapest list price if stock appears: OVH RISE-8 256 GB | 25 + 3 = 28 x RISE-8 (40,321 each), vRack; OVH Object Storage (requests free) | €5,320 ($5,895) + store | €0 | $0.006 (unavailable today) |
| **US: Oracle A1** | 25 + 3 = 28 x A1.Flex 16 OCPU / 256 GB (40,321 each); Object Storage (about 225M writes and 2.7 TB: about $145); a flexible LB ($8.25 plus bandwidth) | $11,119 + $145 + $8 = **about $11,272**, plus egress past 10 TB: at 0.1-0.2 GB a user **[EST, COST-MODEL.md]**, $760-1,610 | none | $0.011-0.013 |
| US, x86: Vultr bare metal 384 GB | 17 + 2 = 19 x vbm-24c-384gb-amd (59,841 each); R2 as the store | $15,675 + R2 ($675-1,350 **[EST]**) | none | $0.016-0.017 |

Which EU shape: AX102 at €159 when that type can be bought (AX102-1 is "several weeks" in Germany, "5-6 workdays" in
Finland); otherwise AX162 at 512 GB, whose €1.20/GB beats the €259 AX102 (€2.02/GB). The AX162's cost is 80,000 users
per failure: a dropped node's users all re-read their blobs from the store at once, 107 s of one bucket's 750
requests a second **[EST]**, so split the store across at least 8 buckets before choosing it. With a model key, RAM
grows 1.79x: 90 AX102 plus 9 spare, which is 99 servers plus routers on one vSwitch, over its 100: plan two vSwitches
or the AX162. Monitoring past about 33 nodes exceeds Grafana Cloud's free 10k series (DEPLOY.md §8, **unverified**
terms): self-host Prometheus on a router box.

## 3. Data residency and compliance

- **EU tenants** (GDPR, often Schrems II wording: "no transfer to the US, no US-owned processor"): Hetzner (DE, FI),
  OVHcloud (FR), Scaleway (FR) and netcup (DE, AT) are EU companies with EU datacentres, so no transfer mechanism is
  needed for the hosting layer. AWS, Azure, GCP and Oracle offer EU regions, but as US-owned providers they remain
  subject to the US CLOUD Act; some EU buyers ask about that explicitly. Hetzner's US cloud locations and netcup's
  Manassas site are for US data only.
- **US tenants** care less about location and more about the audit report: they send a security questionnaire (SIG
  Lite, CAIQ or their own) that asks for the vendor's SOC 2 Type II and the subprocessors' reports.
- **What a B2B customer asks Eden for:** a DPA (Art. 28 GDPR; with SCCs or the EU-US Data Privacy Framework for EU
  data leaving the EU), the subprocessor list (the host; OpenRouter and the model providers when a model key is set;
  the object store), data location, encryption at rest (DEPLOY.md §14: users persisted encrypted, the key beside them),
  retention and deletion (at most 7 days, D428), breach notification terms, and eventually Eden's own SOC 2 Type II or
  ISO 27001. A provider's certificate does not make Eden compliant; it only answers the datacentre questions.

| Provider | DPA | ISO 27001 | SOC 2 Type II | Other | Source |
| --- | --- | --- | --- | --- | --- |
| Hetzner | standard Art. 28 template, concluded in the console, no custom DPAs | yes, ISO/IEC 27001:2022 (Hetzner Online, Hetzner Finland) | **no**, by choice | C5: Hetzner's pages conflict (**unverified**) | [information security](https://docs.hetzner.com/general/company-and-policy/information-security-at-hetzner/), [data protection](https://docs.hetzner.com/general/company-and-policy/data-protection-at-hetzner) |
| OVHcloud | yes | yes, 27001/27017/27018/27701 including bare metal | yes (security, availability, confidentiality) | HDS, C5, SecNumCloud on some offers | [SOC](https://www.ovhcloud.com/en/compliance/soc-1-2-3/), [security sheet](https://docs.ovhcloud.com/en/guides/account-and-service-management/account-information/security-specification-pci) |
| netcup | free template in the control panel | yes (TÜV Nord; the certificate found ends 2026-10-30, renewal **unverified**) | no (**unverified**) | ISO 27701 | [certifications](https://netcup.com/en/about-netcup/certifications), [DPA](https://www.netcup.com/en/helpcenter/documentation/general/dpa) |
| Scaleway | yes | yes, 27001:2022 (certificate to 2026-12-05) | none found | HDS; SecNumCloud in progress | [security and compliance](https://www.scaleway.com/en/security-and-compliance/) |
| Oracle | yes | yes | yes, SOC 1/2/3 | C5, EU Sovereign Cloud (**unverified**: page not read) | [cloud compliance](https://www.oracle.com/corporate/cloud-compliance/) |
| DigitalOcean | yes | per datacentre | yes, SOC 2 and SOC 3 Type II | | [certification reports](https://digitalocean.com/trust/certification-reports) |
| Vultr | yes | 27001:2022, 27017, 27018 | yes, SOC 2+ (HIPAA) | CSA STAR 1 | [compliance](https://www.vultr.com/legal/compliance/) |
| Fly.io, Render | yes | datacentres only | yes (Fly: Aprio audit; Render since 2023) | | [Fly](https://fly.io/legal/security-questionnaire/), [Render](https://render.com/blog/render-soc2-compliance) |
| Railway | yes | none found | **unverified** (trust centre offers a report; third parties disagree) | HIPAA BAA on Enterprise | [pricing](https://railway.com/pricing) |
| AWS, GCP, Azure | yes | yes | yes | everything a buyer asks for | (standard; not re-read) |

So: **EU-first B2B on Hetzner** answers residency well and the security review with ISO 27001; a US enterprise that
insists every subprocessor have SOC 2 is served by a US region on **Oracle** (or OVH US, Vultr, a hyperscaler).

## 4. Risks

- **Hetzner account.** New accounts are checked: a government ID or a credit-card prepayment in the customer's own
  name; rejections are not explained and a second one is final; VPN signups are flagged
  (https://docs.hetzner.com/general/security-and-identify/fraud-prevention-faq/, community reports via search). Open
  the account early, from the company's own network, with matching details. Support is by ticket (**unverified**).
- **Hetzner stock and price.** Three price changes in 2026 (1 April, 15 June, a cut on 30 June per reports,
  **unverified**), the -LTD types "while stock lasts", AX42-1 and AX102-1 "several weeks" in Germany, every cloud line
  unavailable today. A dedicated server takes minutes to weeks to arrive: keep one spare in the fleet and order the
  next box at 75% memory (DEPLOY.md §10), not at 90%. Dedicated AX is EU only.
- **Oracle.** Free tier cut to 2 OCPU / 12 GB (Oracle's docs) while the price API still shows the old 3,000 / 18,000
  free hours on A1; idle reclamation of free instances; "out of host capacity" on A1 launches, worst on free accounts
  (a PAYG upgrade is the usual fix, with a temporary $100 card hold; reports via search, **unverified**). At 1M users
  the fleet needs about 450 A1 OCPUs and 7 TB in one region: request service-limit increases weeks ahead, and keep
  E4 (x86, $2.24/GB) as the same-region fallback.
- **OVHcloud.** The cheapest RAM in this note but the thinnest stock (most 128-256 GB configurations unavailable in
  every EU datacentre today); Kimsufi and So you Start have no vRack. The 2021 Strasbourg fire is why the store
  should live in another site than the nodes.
- **netcup and Scaleway.** Prices on 12-month terms; netcup's net/gross labelling is unclear; Scaleway's cheapest
  RAM (EM-B111X) runs 2012-era Xeons and charges a month's rent as a commitment fee on monthly billing.
- **ARM vs x86 for Bun.** Bun ships linux-arm64 builds and Eden's image is multi-arch: the runtime base
  `oven/bun:1.4.4-distroless` (D1600) publishes amd64 and arm64
  (https://hub.docker.com/v2/repositories/oven/bun/tags/1.4.4-distroless). D990 verified the arm64 build under QEMU
  only; no Eden latency or RSS figure has been measured on real ARM hardware, so measure an A1 box with
  `users.bench.ts` before sizing an ARM fleet. Bun's JavaScriptCore has aborted on ARM64 kernels with 64K pages
  (an issue opened February 2026 against a Bun-built binary, closed March 2026:
  https://claudeissues.com/issue/25713-bug-native-binary-bun-jsc-aborts-on-arm64-linux-with-64k-page-size-kernels,
  **unverified**); Oracle offers a 64K kernel (`kernel-uek64k`) on Ampere shapes
  (https://docs.oracle.com/en/operating-systems/uek/7/relnotes7.3/7.3-feature-ol9-64k-page.html). Use Ubuntu 24.04
  (4K pages), as the kit does. Everything else being equal, x86 is the lower-risk choice for the fleet.
- **Managed platforms** (Fly.io, Railway, Render): 4-14x the RAM price and per-GB egress; they suit a demo, not a
  memory-bound service holding thousands of users per box.

## 5. What in DEPLOY.md is out of date

| Where | It says | Correct as of 2026-11-12 |
| --- | --- | --- |
| §0, "Where" | Hetzner dedicated "not hourly"; "Hetzner's cheap cloud lines were out of stock on 2026-11-11" | dedicated is billed by the hour up to the monthly price (setup fee still charged; **unverified**, search); **every** Hetzner cloud line (CX, CAX, CPX, CCX) reads "currently unavailable" |
| §2 table, Hetzner dedicated | "$1.0-1.4 per GB-month" | AX41 €59 ($1.02/GB, €0 setup); AX42 €79-99 ($1.37-1.71, €49); AX102 €159-259 ($1.38-2.24, €129); AX162 512 GB €614 ($1.33, €304). AX42-1 and AX102-1 deliver in "several weeks" in Germany |
| §2 table, OVHcloud | "$3.03 per GB on a 12-month plan" | public cloud r3 €3.02/GB (hourly, $3.35); OVH dedicated (KS, SYS, Rise) lists €0.28-0.97/GB with €0 setup, but most configurations are unavailable |
| §2 table, Hetzner Cloud | routers and the load balancer, "and Eden machines when its stock returns" | still true, but no cloud type is orderable today: put the routers on dedicated boxes or on the nodes |
| §2.2 | "Hetzner CPX32 in Helsinki about €30.49/month (4 vCPU, 8 GB; in stock that day)"; "AX41/AX42 64 GB at €59-79 plus setup" | CPX32 is unavailable; AX41 €59 (no setup), AX42 €79-99 plus €49 |
| §9, nodes | (no limits given) | a vSwitch holds at most 100 servers; Hetzner Object Storage allows 750 requests/s per bucket and 100 buckets an account |

Unchanged and confirmed today: Oracle A1 $0.01 an OCPU-hour and $0.0015 a GB-hour ($7.30 and $1.095 a month), the
Always Free 1,500 OCPU-hours and 9,000 GB-hours (2 OCPU / 12 GB), 10 TB free egress; Hetzner Object Storage €6.49
with no request fees; Cloudflare R2 $0.015/GB and $4.50 per million writes. docs/COST-MODEL.md, "Hosting", priced the
1k / 10k / 100k fleets at AX41 ($66) and AX102 ($177) a box: still the low end of today's ranges.

## 6. What this session did not verify

Scaleway prices (403), Render's instance price, netcup's setup fee, traffic and VAT basis, Hetzner's auction listings
and its June price table (404), which Hetzner type maps to which price, GCP (not re-read), Azure and GCP storage and
egress, Oracle's region list and SLA, every provider's support quality. Nothing was ordered, so no stock figure has
been tested in a console.
