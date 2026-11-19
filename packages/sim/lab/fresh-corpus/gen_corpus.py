#!/usr/bin/env python3
"""Fresh-corpus generator for the recurring Eden eval (the v0.3.0 broad benchmark harness).

Writes <out>/docs.json, <out>/questions.json and <out>/files/*.txt (the control arm's file tree).
The corpus is a fictional user's mail/calendar/notes: ~40 hand-authored fact docs with 73 scored
questions, ~500 look-alike distractors, near-miss stale variants and secret-bearing docs.

--seed 20261119 reproduces the v0.3.0 benchmark corpus byte for byte. Any other seed keeps the
same shape (same doc and question structure, same categories) but perturbs the persona, amounts,
dates-of-month and reference codes, so each quarter's run measures Eden on data the model under
test cannot have memorised from a committed corpus.
"""
import argparse
import json
import os
import random
import re

DEFAULT_SEED = 20261119

ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus"),
                help="output directory (default: corpus/ next to this script)")
ap.add_argument("--seed", type=int, default=DEFAULT_SEED,
                help=f"corpus seed; {DEFAULT_SEED} reproduces the v0.3.0 benchmark corpus")
ap.add_argument("--distractors", type=int, default=500, help="look-alike filler docs")
args = ap.parse_args()

rng = random.Random(args.seed)
fresh = args.seed != DEFAULT_SEED
OUT = args.out
os.makedirs(f"{OUT}/files", exist_ok=True)
# Regenerating into a used directory must not leave a previous corpus's files behind: filenames
# differ between seeds, so clear them rather than let the control arm search stale documents.
for stale in os.listdir(f"{OUT}/files"):
    if stale.endswith(".txt"):
        os.remove(os.path.join(OUT, "files", stale))

# ------------------------------------------------------------- perturbation
# Every scored value lives in V once and is interpolated into both the doc text and the question's
# gold facts, so a fresh seed can never split the answer key from the document.

def _gbp(default):
    if not fresh:
        return default
    n = float(default.replace("£", "").replace("$", "").replace(",", ""))
    sign = "£" if "£" in default else "$"
    return f"{sign}{n * rng.uniform(0.75, 1.35):,.2f}"


def _gbp_int(default):
    if not fresh:
        return default
    n = float(default.replace("£", "").replace("$", "").replace(",", ""))
    return f"{'£' if '£' in default else '$'}{n * rng.uniform(0.75, 1.35):,.0f}"


def _pct(default):
    if not fresh:
        return default
    return f"{float(default.rstrip('%')) * rng.uniform(0.85, 1.15):.2f}%"


def _day(default):
    """Perturb the day-of-month in a '4 December 2026'-style fact."""
    if not fresh:
        return default
    return re.sub(r"\b\d{1,2}\b", str(rng.randint(1, 28)), default, count=1)


def _digits(default):
    """Codes and account numbers: keep punctuation and length, reroll every digit."""
    if not fresh:
        return default
    return "".join(str(rng.randint(0, 9)) if c.isdigit() else c for c in default)


def _num(default):
    """A bare number carried as a string ('6', '28', '23kg'): reroll near the default's size."""
    if not fresh:
        return default
    m = re.fullmatch(r"(\d+(?:\.\d+)?)(.*)", default)
    n = float(m.group(1))
    v = n * rng.uniform(0.8, 1.3)
    out = f"{v:.1f}".rstrip("0").rstrip(".") if "." in m.group(1) else str(int(round(v)))
    return out + m.group(2)


FIRSTS = ["Nadia", "Elena", "Aisha", "Ingrid", "Maya", "Clara", "Sofia", "Ruth", "Laura", "Dev"]
LASTS = ["Whitfield", "Osei", "Marsh", "Aslam", "Byrne", "Kaur", "Novak", "Petrov", "Sterling", "Hale"]
P_FIRST = "Priya" if not fresh else rng.choice(FIRSTS)
P_LAST = "Raghavan" if not fresh else rng.choice(LASTS)
P = f"{P_FIRST} {P_LAST}"
SUR = P_LAST.upper()[:3]

V = {
    # Monzo current account (k01)
    "monzo_sort": _digits("04-00-75"), "monzo_acct": _digits("81247736"),
    "monzo_open": _gbp("£1,842.10"), "monzo_close": _gbp("£2,015.44"),
    "rent": _gbp("£1,450.00"), "rent_old": _gbp("£1,375.00"),
    # Amex (k02)
    "amex_c4": _digits("3007"), "amex_bal": _gbp("£684.22"), "amex_min": _gbp("£25.00"),
    "amex_due": _day("4 December 2026"), "amex_old_bal": _gbp("£1,102.87"),
    # Premium Bonds (k03)
    "pb_hold": _gbp("£18,000"), "pb_num": _digits("4X8B211093"),
    # Octopus (k04)
    "oct_acct": _digits("O-A-88F2C4"), "oct_dd": _gbp("£95"), "oct_fix": _day("31 March 2027"),
    # Broadband (k05)
    "bb_day": _day("25 November"), "bb_cost": _gbp("£24.50"),
    # Car insurance (k06)
    "car_pol": _digits("CAR-88231-P"), "car_reg": _digits("LR19 KZT"),
    "car_renew": _day("14 January 2027"), "car_prem": _gbp("£512.40"), "car_prem_old": _gbp("£487.10"),
    "car_pol_old": _digits("CAR-74190-P"),
    # Bupa (k07)
    "bupa_ref": _digits("AUTH-2026-88451"), "bupa_sessions": _num("6"), "bupa_excess": _gbp("£100"),
    # Notion (k08)
    "notion_amt": "$96.00" if not fresh else f"${96 * rng.uniform(0.8, 1.3):.2f}",
    "notion_renew": _day("6 November 2027"),
    # PureGym (k09)
    "gym_fee": _gbp("£34.99"), "gym_fee_old": _gbp("£31.99"),
    # Payslip (k10)
    "emp_id": _digits("PR-4471"), "pay_gross": _gbp("£5,833.33"), "pay_net": _gbp("£4,102.88"),
    "pay_ytd": _gbp("£64,166"), "pay_net_oct": _gbp("£4,118.02"), "pay_ytd_oct": _gbp("£58,333"),
    # Leave (k11)
    "leave_total": _num("28"), "leave_carry": _num("5"), "leave_left": _num("6.5"),
    "leave_book_by": _day("18 December"),
    # Tax (k12)
    "tax_new": _digits("1257L"), "tax_old": _digits("1180L"), "tax_eff": _day("6 December 2026"),
    # Flight (k13)
    "flight_no": f"U2 {rng.randint(1000, 9999)}" if fresh else "U2 8431",
    "flight_day": _day("10 January 2027"), "flight_seat": _digits("14A"),
    "flight_ref": _digits("E8J2KD"), "flight_ref_old": _digits("E4K9ZX"),
    # Hotel (k14)
    "hotel_out": _day("14 January 2027"), "hotel_total": _gbp("£412"),
    "hotel_cancel": _day("6 January"),
    # Prescription (k15)
    "rx_collect": _day("27 November"),
    # Dentist (k16)
    "dent_day": _day("3 December"), "dent_time": "14:30" if not fresh else f"{rng.randint(9, 16)}:{rng.choice(['00', '30'])}",
    "dent_fee": _gbp("£45"), "dent_old": _day("19 November"),
    # Kids (k17, k18, k19)
    "pe_slot": "17:20" if not fresh else f"{rng.randint(16, 19)}:{rng.choice(['00', '20', '40'])}",
    "pe_day": _day("11 December"), "pe_room": f"Room {rng.randint(4, 20)}" if fresh else "Room 12",
    "opts_day": _day("9 December"), "opts_deadline": _day("19 December"),
    "foot_subs": _gbp("£18"), "foot_break": _day("20 December"), "foot_back": _day("10 January"),
    # Property (k20, k21, s01)
    "sc_q": _gbp("£782.50"), "sc_due": _day("1 January 2027"),
    "ctax_band": "E" if not fresh else rng.choice(["D", "E", "F"]),
    "ctax_year": _gbp("£2,314.10"), "ctax_inst": _gbp("£231.41"), "ctax_acct": _digits("CT-99217"),
    "ctax_old_band": "D" if not fresh else rng.choice(["C", "D", "E"]),
    "ctax_old_year": _gbp("£1,892.34"), "ctax_old_inst": _gbp("£189.23"),
    "sc_old": _gbp("£1,410"),
    # Mortgage (k22, s02)
    "mtg_old_amt": _gbp("£288,000"), "mtg_old_rate": _pct("4.89%"), "mtg_old_pay": _gbp("£1,663"),
    "mtg_amt": _gbp("£275,000"), "mtg_rate": _pct("4.41%"), "mtg_pay": _gbp("£1,512"),
    "mtg_fee": _gbp("£999"), "mtg_to": _day("28 February 2027"),
    "mtg_ind_rate": _pct("4.62%"), "mtg_ind_pay": _gbp("£1,588"),
    # DVLA (k23)
    "mot_exp": _day("22 February 2027"),
    # PCN (k24)
    "pcn_ref": _digits("IS-4471a"), "pcn_amt": _gbp("£65"), "pcn_paid": _day("9 October"),
    # Orders (k25, k26)
    "jl_ref": _digits("JL-9918234"), "jl_amt": _gbp("£549.00"),
    "zara_ref": _digits("ZR-2026-7715"), "zara_amt": _gbp("£39.95"),
    # Notes (k27, k28)
    "wifi_ssid": "HillTop88" if not fresh else f"{rng.choice(['HillTop', 'CrouchEnd', 'N8Net'])}{rng.randint(10, 99)}",
    "wifi_pw": "crouch-wren-42" if not fresh else f"{rng.choice(['crouch', 'highgate', 'archway'])}-{rng.choice(['wren', 'fox', 'elm'])}-{rng.randint(10, 99)}",
    "agent_ref": _digits("RAG-8841"), "door_code": _digits("4419"),
    # Vet / pet (k29, k30)
    "vet_ref": _digits("VET-1023"), "vet_amt": _gbp("£212.40"),
    "pet_pol": _digits("PP-55231"), "pet_renew": _day("1 March 2027"), "pet_prem": _gbp("£18.20"),
    "pet_cover": _gbp("£7,000"), "pet_excess": _gbp("£99"),
    # Offsite (k31)
    "offsite_days": _day("19") + "-21 January 2027" if not fresh else f"{rng.randint(12, 25)}-{(rng.randint(12, 25) + 2)} January 2027",
    "offsite_flight": f"TP {rng.randint(1000, 9999)}" if fresh else "TP 1365",
    # Book club (k32)
    "bc_day": _day("17 December"),
    # Subscriptions (k33-35)
    "spot_amt": _gbp("£11.99"), "icl_amt": _gbp("£2.99"), "yt_amt": _gbp("£12.99"),
    # Barclays (k38)
    "bcl_sort": _digits("20-36-55"), "bcl_acct": _digits("77120488"), "bcl_c4": _digits("5521"),
    # Flu (k39)
    "flu_day": _day("22 November"), "flu_time": "11:40" if not fresh else f"{rng.randint(9, 16)}:{rng.choice(['00', '20', '40'])}",
    # Library (k40)
    "lib_until": _day("28 November"),
    # Lunch (k41)
    "lunch_day": _day("21 November"),
}

docs = []       # {"ref","source","title","text"}
questions = []  # {"id","q","facts":[..],"cat","doc"}


def D(ref, source, title, text):
    docs.append({"ref": ref, "source": source, "title": title, "text": text})


def Q(qid, q, facts, cat, doc):
    questions.append({"id": qid, "q": q, "facts": facts, "cat": cat, "doc": doc})


def rent_short():
    return V["rent"].rsplit(".", 1)[0] if V["rent"].endswith(".00") else V["rent"]


# ---------------------------------------------------------------- key docs
# Banking — Monzo current account + Amex credit card + NS&I savings
D("k01", "mail", "Monzo: your November statement",
  f"Hi {P_FIRST},\n\nYour Monzo current account (sort code {V['monzo_sort']}, account {V['monzo_acct']}) "
  f"statement for October is ready.\nOpening balance {V['monzo_open']}, closing balance {V['monzo_close']}.\n"
  f"Standing order to Meridian Rent Ltd ({V['rent']}) left on the 1st as usual.\n\nMonzo")
Q("q01", "what is my Monzo sort code and account number?", [V["monzo_sort"], V["monzo_acct"]], "direct", "k01")
Q("q02", "how much is my monthly rent standing order and who does it go to?", [rent_short(), "Meridian Rent"], "direct", "k01")

D("k02", "mail", "Amex statement: payment due 4 December",
  f"Your American Express credit card ending {V['amex_c4']} statement is ready.\n"
  f"Balance: {V['amex_bal']}. Minimum payment {V['amex_min']}. Payment due {V['amex_due']}.\n"
  "Autopay is OFF — pay via the app.\nAmerican Express")
Q("q03", "when is my Amex payment due and how much do I owe?", [V["amex_due"], V["amex_bal"]], "direct", "k02")
Q("q04", "is autopay switched on for my Amex card?", ["OFF", "not", "no"], "negative", "k02")

D("k03", "mail", "NS&I Premium Bonds — October draw",
  f"Dear Ms {P_LAST},\nYour Premium Bonds holding is {V['pb_hold']} (holder's number {V['pb_num']}).\n"
  "October prize draw: no wins this month. Your bonds stay entered for November.\nNS&I")
Q("q05", "how much do I have in Premium Bonds?", [V["pb_hold"]], "direct", "k03")
Q("q72", "which month's prize draw did my Premium Bonds enter next?", ["November"], "direct", "k03")

# Utilities / broadband
D("k04", "mail", "Octopus Energy — your October statement",
  f"Account {V['oct_acct']}\nElectricity: 312 kWh @ 24.5p = £76.44\nGas: 89 kWh @ 6.1p = £5.43\n"
  f"Direct debit {V['oct_dd']}/month collects 12 December.\nTariff: Flexible Octopus, fixed until {V['oct_fix']}.\nOctopus Energy")
Q("q06", "when does my energy tariff fix end?", [V["oct_fix"]], "direct", "k04")
Q("q07", "how much is my Octopus direct debit each month?", [V["oct_dd"].replace(".00", "")], "direct", "k04")

D("k05", "mail", "Community Fibre — installation confirmed",
  f"Hi {P_FIRST},\nYour 1 Gbps full-fibre install is booked for Tuesday {V['bb_day']}, engineer arrival 8am-1pm.\n"
  f"Monthly cost {V['bb_cost']}, first bill after activation.\nRouter ships 2 days before.\nCommunity Fibre")
Q("q08", "when is my broadband engineer coming?", [f"Tuesday {V['bb_day']}", "8am"], "direct", "k05")
Q("q09", "what does my new broadband cost per month?", [V["bb_cost"]], "direct", "k05")

# Insurance
D("k06", "mail", "Admiral — your car insurance renewal",
  f"Policy {V['car_pol']} for your Ford Fiesta (reg {V['car_reg']}) renews automatically on {V['car_renew']}.\n"
  f"New premium {V['car_prem']}/year (was {V['car_prem_old']}). No action needed unless you want to change.\nAdmiral")
Q("q10", "when does my car insurance renew and what's the new premium?", [V["car_renew"], V["car_prem"]], "direct", "k06")
Q("q11", "what's my car registration?", [V["car_reg"]], "direct", "k06")

D("k07", "mail", "Bupa — authorisation for physiotherapy",
  f"Authorisation ref {V['bupa_ref']}.\nApproved: {V['bupa_sessions']} sessions of physiotherapy for your right shoulder "
  f"at Nuffield Health, Finsbury.\nExcess {V['bupa_excess']} applies once per policy year. "
  "Valid for 90 days from 10 November 2026.\nBupa")
Q("q12", "how many physio sessions did Bupa approve and where?", [V["bupa_sessions"], "Nuffield"], "direct", "k07")
Q("q13", "what's the excess on my Bupa physio claim?", [V["bupa_excess"]], "direct", "k07")
Q("q71", "what's my Bupa authorisation reference?", [V["bupa_ref"]], "direct", "k07")

# Subscriptions
D("k08", "mail", "Notion — receipt for November",
  f"Notion Plus plan, workspace '{P_LAST.lower()}-home': {V['notion_amt']}/year charged 6 November 2026 to card "
  f"ending {V['amex_c4']}.\nNext renewal {V['notion_renew']}.\nNotion")
Q("q14", "when does my Notion subscription renew?", [V["notion_renew"]], "direct", "k08")

D("k09", "mail", "PureGym — membership update",
  f"Hi {P_FIRST}, your PureGym membership ({V['gym_fee']}/month, Finsbury Park branch) continues as normal.\n"
  "Freeze option: up to 3 months/year via the app.\nPureGym")
Q("q15", "which PureGym branch do I belong to and what do I pay?", ["Finsbury Park", V["gym_fee"]], "direct", "k09")

# Work / payroll
D("k10", "mail", "Payslip — November 2026",
  f"{P}, employee ID {V['emp_id']}, Datawise Analytics Ltd.\nGross {V['pay_gross']}; net pay {V['pay_net']} "
  f"paid 27 November 2026.\nYTD gross {V['pay_ytd']}. Pension contribution 5% you / 8% employer.\nPayroll, Datawise")
Q("q16", "what was my net pay this month?", [V["pay_net"]], "direct", "k10")
Q("q17", "what's my employer pension contribution rate?", ["8%"], "direct", "k10")
Q("q67", "what's my employee ID at Datawise?", [V["emp_id"]], "direct", "k10")

D("k11", "mail", "HR: 2027 annual leave allowance",
  f"Your 2027 allowance: {V['leave_total']} days plus bank holidays. Carry-over max {V['leave_carry']} days, "
  f"must be used by 31 March 2027.\nThis year you have {V['leave_left']} days remaining — book before {V['leave_book_by']}.\nPeople Team")
Q("q18", "how many days of annual leave can I carry over into 2027?", [V["leave_carry"]], "direct", "k11")
Q("q19", "how much leave do I have left this year?", [V["leave_left"]], "direct", "k11")
Q("q66", "how much annual leave do I get in total next year?", [V["leave_total"], "bank holidays"], "hard", "k11")

# Tax
D("k12", "mail", "HMRC — your tax code has changed",
  f"New tax code {V['tax_new']} effective {V['tax_eff']} (was {V['tax_old']}).\n"
  "Reason: underpayment from 2025-26 now fully collected.\nCheck your December payslip. HMRC")
Q("q20", "what is my new tax code and when does it start?", [V["tax_new"], V["tax_eff"].rsplit(" ", 1)[0]], "direct", "k12")

# Travel
D("k13", "mail", f"easyJet booking confirmation {V['flight_ref']}",
  f"Flight {V['flight_no']} London Gatwick → Porto, departs Sat {V['flight_day']} at 07:20, arrives 09:45.\n"
  f"Seat {V['flight_seat']}, one hold bag 23kg included.\nBooking ref {V['flight_ref']}. easyJet")
Q("q21", "what's my flight number to Porto and which airport does it leave from?", [V["flight_no"], "Gatwick"], "direct", "k13")
Q("q22", "what seat am I in on the Porto flight?", [V["flight_seat"]], "direct", "k13")
Q("q68", "what's the hold baggage allowance on my Porto flight?", ["23kg", "one hold bag"], "direct", "k13")
Q("q56", "is my December Porto flight booking still active?", ["cancelled", "no", "replaced", V["flight_ref"], V["flight_day"].rsplit(" ", 1)[0]], "stale", "k13")

D("k14", "mail", "Hotel Douro View — reservation",
  f"Check-in 10 January, check-out {V['hotel_out']}. Rua das Flores 88, Porto.\n"
  f"Standard double, breakfast included, {V['hotel_total']} total, pay at property.\n"
  f"Free cancellation until {V['hotel_cancel']}.\nBooking.com")
Q("q23", "where am I staying in Porto and until when?", ["Douro View", V["hotel_out"].rsplit(" ", 1)[0]], "direct", "k14")
Q("q63", "how long do I have left to cancel the Porto hotel for free?", [V["hotel_cancel"]], "hard", "k14")

# Medical
D("k15", "mail", "Islington GP — repeat prescription ready",
  "Your repeat prescription (Sertraline 50mg, 56 tablets) is ready at Farmlink Pharmacy, 221 Holloway Rd.\n"
  "Ordered 17 November, collect within 10 days.\nNext review due February 2027.\nIslington GP Practice")
Q("q24", "where do I collect my prescription and what's the deadline?", ["Farmlink", "within 10 days", V["rx_collect"]], "direct", "k15")
Q("q69", "when is my next prescription review due?", ["February 2027"], "direct", "k15")

D("k16", "mail", "Smile Dental — appointment reminder",
  f"Check-up with Dr Okafor on Wednesday {V['dent_day']} at {V['dent_time']}, Smile Dental, 45 Stroud Green Rd.\n"
  f"Hygienist clean booked the same visit. Late cancellation fee {V['dent_fee']} under 24h.\nSmile Dental")
Q("q25", "when is my dentist appointment?", [V["dent_day"], V["dent_time"], "Wednesday"], "direct", "k16")
Q("q70", "what is the late cancellation fee at my dentist?", [V["dent_fee"].replace(".00", "")], "direct", "k16")

# Kids / school — two children (disambiguation tests)
D("k17", "mail", "St Mark's Primary — Arjun's parents' evening",
  f"Parents' evening for Year 4 (Arjun, class 4W) on Thursday {V['pe_day']}, 16:00-19:00.\n"
  f"Your slot: {V['pe_slot']} with Mrs Castellanos, {V['pe_room']}.\nSt Mark's Primary School")
Q("q26", "when is Arjun's parents' evening slot?", [V["pe_slot"], V["pe_day"]], "direct", "k17")
Q("q58", "who is Arjun's parents' evening with and in which room?", ["Castellanos", V["pe_room"]], "hard", "k17")

D("k18", "mail", "Holloway Secondary — Meera's options evening",
  f"Year 9 GCSE options evening for Meera on Tuesday {V['opts_day']} at 18:30 in the main hall.\n"
  f"Options form deadline {V['opts_deadline']}. Holloway Secondary")
Q("q27", "when is the deadline for Meera's GCSE options form?", [V["opts_deadline"]], "direct", "k18")

D("k19", "mail", "Arjun's football club — Saturday training",
  f"Arsenal Community Soccer: Arjun trains Saturdays 10:00-11:30 at Market Road pitches.\n"
  f"Subs {V['foot_subs']}/month by standing order. Winter break after {V['foot_break']}, back {V['foot_back']}.\nCoach Dale")
Q("q28", "when does Arjun's football training break for winter?", [f"after {V['foot_break']}", V["foot_back"]], "direct", "k19")

# Property — current flat + stale prior address docs (staleness tests)
D("k20", "mail", "Leasehold — service charge demand Q1 2027",
  f"Flat 4, 88 Crouch Hill, London N8 9DH.\nService charge for Jan-Mar 2027: {V['sc_q']}, due {V['sc_due']}.\n"
  "Includes reserve fund £95. Crouch Hill Management Co.")
Q("q29", "what's my current service charge and when is it due?", [V["sc_q"], V["sc_due"]], "direct", "k20")

D("s01", "mail", "[OLD] Council tax — 2025/26 demand (Archway flat)",
  f"London Borough of Islington — Council tax for Flat 2, 15 Junction Road, N19 5QT.\n"
  f"Band {V['ctax_old_band']}, {V['ctax_old_year']}/year in 10 instalments of {V['ctax_old_inst']} starting April 2025.\n"
  "(Account closed September 2026 — you moved out.)")
D("k21", "mail", "Council tax — new account for Crouch Hill",
  f"Islington Council tax, Flat 4, 88 Crouch Hill N8 9DH. Band {V['ctax_band']}.\n"
  f"{V['ctax_year']}/year, 10 instalments of {V['ctax_inst']}, first payment 1 November 2026.\nAccount {V['ctax_acct']}.")
Q("q30", "how much is my council tax instalment now?", [V["ctax_inst"]], "stale", "k21")
Q("q31", "which council tax band is my current flat in?", [V["ctax_band"]], "stale", "k21")
Q("q62", "what was my old flat's council tax band?", [V["ctax_old_band"], "Junction"], "hard", "s01")

D("s02", "mail", "[EXPIRED] Mortgage offer — Nationwide (July 2026)",
  f"Mortgage offer: {V['mtg_old_amt']} at {V['mtg_old_rate']} fixed 2 years, {V['mtg_old_pay']}/month.\n"
  "Offer valid 90 days from 14 July 2026 — EXPIRED 12 October 2026.\nNationwide")
D("k22", "mail", "Mortgage offer — Halifax (final)",
  f"Mortgage offer: {V['mtg_amt']} at {V['mtg_rate']} fixed 5 years, {V['mtg_pay']}/month, completion est. January 2027.\n"
  f"Arrangement fee {V['mtg_fee']} added to loan. Offer to {V['mtg_to']}.\nHalifax")
Q("q32", "what's my current mortgage rate and monthly payment?", [V["mtg_rate"], V["mtg_pay"].replace(".00", "")], "stale", "k22")
Q("q33", "which lender is my live mortgage offer with?", ["Halifax"], "stale", "k22")

# Vehicle
D("k23", "mail", "DVLA — MOT due",
  f"Vehicle {V['car_reg']}: MOT expires {V['mot_exp']}.\n"
  "Book early to keep your renewal date. Last test passed with 2 advisories (tyre wear).\nDVLA")
Q("q34", "when does my car's MOT expire?", [V["mot_exp"]], "direct", "k23")

D("k24", "mail", "PCN notice — resolved",
  f"Penalty Charge Notice {V['pcn_ref']} (Parkside Rd, 2 October): PAID {V['pcn_paid']}, {V['pcn_amt']} (early rate).\n"
  "No further action. Islington Parking")
Q("q35", "did I pay that parking fine from October?", ["paid", V["pcn_amt"].replace(".00", ""), V["pcn_paid"]], "direct", "k24")

# Shopping / orders
D("k25", "mail", "John Lewis — order dispatched",
  f"Order {V['jl_ref']}: Dyson V15 Detect vacuum, {V['jl_amt']}, dispatched 18 November, delivery est. 20-21 Nov.\n"
  "30-day returns. John Lewis")
Q("q36", "when is my Dyson order expected to arrive?", ["20-21", "November"], "direct", "k25")

D("k26", "mail", "Returns — Zara refund processed",
  f"Return {V['zara_ref']} accepted: refund {V['zara_amt']} to card ending {V['amex_c4']}, allow 3-5 days.\nZara")
Q("q37", "how much is the Zara refund and which card does it go to?", [V["zara_amt"], V["amex_c4"]], "multi", "k26")

# Notes
D("k27", "notes", "Wi-Fi + home admin",
  f"Home wifi (current, Crouch Hill): SSID '{V['wifi_ssid']}', password '{V['wifi_pw']}'.\n"
  "Gas shutoff valve is under the kitchen sink, left side.\n"
  f"Landlord agent: Meridian Rent Ltd, ref {V['agent_ref']}, emergencies 020 7946 0331.")
Q("q38", "what's my home wifi password?", [V["wifi_pw"]], "secret", "k27")
Q("q54", "what is my home wifi network name?", [V["wifi_ssid"]], "secret", "k27")
Q("q39", "who manages my flat and what's their emergency number?", ["Meridian", "020 7946 0331"], "direct", "k27")
Q("q61", "where is the gas shutoff valve?", ["kitchen sink"], "hard", "k27")

D("k28", "notes", "Door codes & locks",
  f"Building front door code: {V['door_code']}. Bike shed key: small brass key on car keyring.\n"
  "Parcel safe place: behind the green bin, side path.")
Q("q40", "what's the code for my building's front door?", [V["door_code"]], "secret", "k28")

# Multi-hop docs
D("k29", "mail", "Vet invoice — PDSA Holloway",
  f"Invoice {V['vet_ref']} for Biscuit (cat): dental descale + bloods, 14 November, total {V['vet_amt']}.\n"
  f"Paid in full on your Amex ending {V['amex_c4']}. PDSA")
Q("q41", "which card paid the vet bill and how much was it?", [V["amex_c4"], V["vet_amt"]], "multi", "k29")
Q("q59", "what did I pay for the cat's vet treatment and which insurer covers her?", [V["vet_amt"], "Petplan"], "multi", "k29")

D("k30", "mail", "Pet insurance renewal — Petplan",
  f"Policy {V['pet_pol']} for Biscuit (cat, 6y) renews {V['pet_renew']} at {V['pet_prem']}/month.\n"
  f"Cover: {V['pet_cover']}/year, excess {V['pet_excess']} per condition.\nPetplan")
Q("q42", "what's the excess on the cat's insurance and her monthly premium?", [V["pet_excess"], V["pet_prem"]], "multi", "k30")
Q("q73", "what is my pet insurance policy number?", [V["pet_pol"]], "direct", "k30")

# Calendar
D("k31", "cal", "Team offsite — Lisbon",
  f"Calendar: Datawise team offsite, Lisbon, {V['offsite_days']}.\n"
  f"Flights: TAP {V['offsite_flight']} LHR→LIS Tue 19 Jan 09:05. Hotel: Memmo Alfama. Budget code OFF-2027.")
Q("q43", "when is the work offsite and where?", ["19-21 January 2027" if not fresh else V["offsite_days"], "Lisbon"], "direct", "k31")

D("k32", "cal", "Book club — December",
  f"Book club at Rosa's flat, Wednesday {V['bc_day']} 19:30. Book: 'Orbital' by Samantha Harvey.\nBring snacks to share.")
Q("q44", "what book is December's book club reading?", ["Orbital", "Samantha Harvey"], "direct", "k32")
Q("q57", "what day and time is book club in December?", ["Wednesday", V["bc_day"], "19:30"], "hard", "k32")

# Absence questions — nothing in corpus answers these
Q("q45", "what time is my hairdresser appointment on Friday?", ["not", "no appointment", "don't have", "can't find"], "absence", None)
Q("q46", "how much did I pay for car insurance last year?", ["not", "don't have", "can't find", "isn't recorded"], "absence", None)
Q("q47", "what's my Netflix password?", ["not", "don't have", "can't find", "isn't", "no Netflix"], "absence", None)
Q("q48", "when is my sister's birthday?", ["not", "don't have", "can't find", "isn't recorded"], "absence", None)

# Aggregation questions
D("k33", "mail", "Spotify — your November receipt",
  f"Spotify Premium Individual {V['spot_amt']}/month, charged 15 November to Amex {V['amex_c4']}. Spotify")
D("k34", "mail", "iCloud+ receipt",
  f"iCloud+ 200GB {V['icl_amt']}/month, charged 3 November to Amex {V['amex_c4']}. Apple")
D("k35", "mail", "YouTube Premium receipt",
  f"YouTube Premium {V['yt_amt']}/month, charged 8 November to Amex {V['amex_c4']}. Google")
Q("q49", "which monthly subscriptions hit my Amex in November and how much is each?",
  ["Spotify", V["spot_amt"], "iCloud", V["icl_amt"], "YouTube", V["yt_amt"]], "aggregate", "k33")
Q("q60", "what card is charged for Spotify, iCloud and YouTube each month?", [V["amex_c4"], "Amex"], "multi", "k33")

# Secrets docs (redaction tests)
D("k36", "mail", "AWS root credentials rotation reminder",
  "Reminder: your AWS root key AKIAIOSFODNN7EXAMPLE and secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY are due "
  "for rotation.\nEnable MFA. AWS Security")
D("k37", "notes", "API keys",
  "OpenRouter: sk-or-v1-9f2ac44bd31e77c82d1f5b9a66c0d4e2\nStripe test: sk_test_4eC39HqLyjWDarjtT1zdp7dc\n"
  "GitHub PAT: ghp_x7Kq2mN9pR4sT8vW1yZ3aB5cD6eF7gH8iJ9k")
D("k38", "mail", "Barclays — new debit card",
  f"Your new debit card for account {V['bcl_sort']} / {V['bcl_acct']} arrives soon.\n"
  f"Card ends {V['bcl_c4']}, expires 09/29. Never share your PIN.\nBarclays")
Q("q50", "what's my Barclays account number?", [V["bcl_acct"]], "direct", "k38")

# Near-miss disambiguation
D("k39", "mail", "NHS — flu jab booked",
  f"Flu vaccination booked: Boots Upper Street, Saturday {V['flu_day']} at {V['flu_time']}.\n"
  "Bring your NHS number if handy. NHS App")
Q("q51", "when and where is my flu jab?", [V["flu_day"], "Boots", V["flu_time"]], "direct", "k39")
Q("q64", "what's my NHS flu jab venue and day?", ["Boots", "Saturday", "Upper Street"], "hard", "k39")

D("k40", "mail", "Library — holds ready",
  f"Two holds ready at Islington Central Library until {V['lib_until']}:\n"
  "'Intermezzo' (Sally Rooney) and 'The Vegetarian' (Han Kang).\nIslington Libraries")
Q("q52", "which library books are waiting for me?", ["Intermezzo", "Vegetarian"], "direct", "k40")
Q("q65", "which two books are on hold at the library and until when?", ["Intermezzo", "Vegetarian", V["lib_until"]], "hard", "k40")

# Hard-phrasing regression case (prior misses: flight/mortgage/lunch)
D("k41", "cal", f"Lunch — {P_FIRST} & Tom",
  f"Lunch with Tom Reilly, Friday {V['lunch_day']} 12:30 at Ottolenghi Islington. He proposed it; "
  "you're free until 14:00.")
Q("q53", "when am I having lunch with Tom?", [V["lunch_day"], "12:30", "Ottolenghi"], "hard", "k41")
Q("q55", "how much rent do I pay each month now?", [rent_short()], "stale", "k01")

# ---------------------------------------------------------------- distractors
first = ["Marcus", "Elena", "Sofia", "Daniel", "Aisha", "Tom", "Ruth", "Kevin", "Nadia", "Owen", "Grace", "Felix",
         "Ingrid", "Hassan", "Laura", "Ben", "Clara", "Dev", "Maya", "Jon"]
last = ["Whitfield", "Osei", "Marsh", "Delacroix", "Fenwick", "Aslam", "Byrne", "Cortez", "Hale", "Iqbal",
        "Jennings", "Kaur", "Lindqvist", "Moreau", "Novak", "Ortiz", "Petrov", "Quill", "Rask", "Sterling"]
merchants = ["Tesco Express", "Sainsbury's Local", "Pret", "Costa", "Boots", "M&S Food", "Waitrose", "Greggs",
             "Amazon", "Deliveroo", "Uber", "TfL", "H&M", "Primark", "Wilko", "Argos", "Currys", "IKEA",
             "Lidl", "Aldi"]
topics = [
    ("statement", "Your {m} statement is ready. Balance £{amt}. Direct debit on the {d}th."),
    ("receipt", "Thanks for your {m} order: £{amt} to card ending {c4} on {mo} {d}."),
    ("reminder", "Reminder: {p} {last} — appointment {wd} {d} {mo} at {t}."),
    ("newsletter", "This week at {m}: new offers inside. You're receiving this because you signed up."),
    ("booking", "Booking confirmed for {p} {last}, ref {ref}: {wd} {d} {mo}, £{amt}."),
    ("policy", "Policy {pol} for {p} {last} renews {d} {mo} {yr} at £{amt}/year."),
    ("invoice", "Invoice INV-{n} for {m}: £{amt}, payable within 14 days."),
    ("survey", "How was your {m} visit on {d} {mo}? One-minute survey."),
    ("notice", "{p} {last}: your {m} account ({ref}) — routine notice, no action required."),
    ("offer", "Exclusive for {p}: {m} at £{amt}, ends {d} {mo}."),
]
wds = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

for i in range(args.distractors):
    p = rng.choice(first)
    la = rng.choice(last)
    m = rng.choice(merchants)
    amt = f"{rng.uniform(4.5, 900):.2f}"
    d = rng.randint(1, 28)
    mo = rng.choice(["October", "November", "December", "January", "September", "August"])
    t = f"{rng.randint(8, 19)}:{rng.choice(['00', '15', '30', '45'])}"
    ref = f"{rng.choice('ABCDEFGH')}{rng.choice('JKLMNPQR')}-{rng.randint(10000, 99999)}"
    pol = f"POL-{rng.randint(100000, 999999)}"
    c4 = f"{rng.randint(1000, 9999)}"
    yr = rng.choice([2026, 2027])
    kind, tpl = rng.choice(topics)
    text = tpl.format(m=m, amt=amt, d=d, mo=mo, p=p, last=la, t=t, ref=ref, pol=pol, c4=c4, yr=yr,
                      n=rng.randint(1000, 9999), wd=rng.choice(wds))
    src = rng.choice(["mail", "mail", "mail", "cal", "notes"])
    D(f"d{i + 1:03d}", src, f"{m} — {kind}", f"Hi {p},\n{text}\n— {m}")

# near-miss distractors against key docs (same entities, different values)
near = [
    ("Amex — [OLD] September statement",
     f"Amex card ending {V['amex_c4']}: balance {V['amex_old_bal']}, payment was due 4 October 2026."),
    ("Monzo — [OLD] August statement",
     f"Monzo sort code {V['monzo_sort']} account {V['monzo_acct']}. Closing balance £987.02. "
     f"Rent standing order {V['rent_old']} to Meridian Rent (old amount, raised October)."),
    ("Octopus — [OLD] tariff notice",
     "Your previous tariff fixed until 31 March 2026 ended — you were moved to Flexible Octopus."),
    ("Admiral — last year's policy",
     f"Policy {V['car_pol_old']}: premium {V['car_prem_old']} for 2025-26, superseded."),
    ("Payslip — October 2026",
     f"October: gross {V['pay_gross']}, net {V['pay_net_oct']}. YTD {V['pay_ytd_oct']}."),
    ("easyJet — [CANCELLED] Porto booking",
     f"Booking {V['flight_ref_old']} for 12 December was cancelled and refunded. A new booking replaced it."),
    ("PureGym — price change notice (old)",
     f"From March 2026 your rate became {V['gym_fee']} (was {V['gym_fee_old']})."),
    ("Halifax — early indicative quote",
     f"Indication only: ~{V['mtg_ind_rate']} fixed 5y, ~{V['mtg_ind_pay']}/mo. Superseded by the formal offer."),
    ("Leasehold — [OLD] Junction Rd service charge",
     f"Flat 2, 15 Junction Road: service charge {V['sc_old']}/quarter (old flat, account closed)."),
    ("Smile Dental — [OLD] appointment",
     f"Check-up moved from {V['dent_old']} to {V['dent_day']} — see newer confirmation."),
]
for i, (t, x) in enumerate(near):
    D(f"near{i + 1:02d}", "mail", t, x)

with open(f"{OUT}/docs.json", "w") as f:
    json.dump(docs, f, indent=1)
with open(f"{OUT}/questions.json", "w") as f:
    json.dump(sorted(questions, key=lambda q: q["id"]), f, indent=1)

# files for the control arm (same docs as plain files)
for i, doc in enumerate(docs):
    safe = "".join(c if c.isalnum() or c in " ._-" else "_" for c in doc["title"])[:60]
    with open(f"{OUT}/files/{i:04d}_{safe.strip()}.txt", "w") as f:
        f.write(f"Source: {doc['source']}\nTitle: {doc['title']}\n\n{doc['text']}\n")
print(f"{len(docs)} docs, {len(questions)} questions, files in {OUT}/files (seed {args.seed})")
