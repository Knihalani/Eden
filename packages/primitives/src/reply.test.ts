import { describe, expect, test } from "bun:test";
import {
  countTerms,
  dedupText,
  PART_FORWARD,
  PART_GREETING,
  PART_HEADER,
  PART_OWN,
  PART_QUOTE,
  PART_SIGNATURE,
  ReplyLines,
  splitReply,
  stripReply,
} from "./reply";

/** [kind, line] for each line, for readable assertions. */
function parts(text: string, boilerplate = true): [number, string][] {
  const lines = new ReplyLines(4);
  const n = splitReply(text, lines, boilerplate);
  const out: [number, string][] = [];
  for (let i = 0; i < n; i++) out.push([lines.kinds[i]!, text.slice(lines.starts[i]!, lines.ends[i]!)]);
  return out;
}

const body = "Can we move the renewal call to Thursday? Legal wants another look at the contract.";

describe("splitReply: quote headers by client and language", () => {
  const cases: [string, string][] = [
    ["Gmail", "On Tue, Oct 27, 2026 at 3:14 PM Dana Lee <dana@acme.com> wrote:"],
    ["Apple Mail", "On Oct 27, 2026, at 15:14, Dana Lee <dana@acme.com> wrote:"],
    ["Thunderbird", "On 10/27/26 15:14, Dana Lee wrote:"],
    ["French", "Le mar. 27 oct. 2026 à 15:14, Dana Lee <dana@acme.com> a écrit :"],
    ["German", "Am Di., 27. Okt. 2026 um 15:14 Uhr schrieb Dana Lee <dana@acme.com>:"],
    ["Spanish", "El mar, 27 oct 2026 a las 15:14, Dana Lee (<dana@acme.com>) escribió:"],
    ["Italian", "Il giorno mar 27 ott 2026 alle ore 15:14 Dana Lee <dana@acme.com> ha scritto:"],
    ["Portuguese", "Em ter., 27 de out. de 2026 às 15:14, Dana Lee <dana@acme.com> escreveu:"],
    ["Dutch", "Op di 27 okt. 2026 om 15:14 schreef Dana Lee <dana@acme.com>:"],
    ["Polish", "W dniu 27.10.2026 o 15:14 Dana Lee <dana@acme.com> napisał:"],
    ["Swedish", "Den 27 okt. 2026 kl. 15:14 skrev Dana Lee <dana@acme.com>:"],
    ["Russian", "27 окт. 2026 г., в 15:14, Dana Lee <dana@acme.com> написал:"],
    ["Chinese", "Dana Lee <dana@acme.com> 于2026年10月27日周二 15:14写道："],
    ["Japanese (verb-less)", "2026年10月27日(火) 15:14 Dana Lee <dana@acme.com>:"],
    ["Hungarian", '2013.02.08. 7:31 keltezéssel, "Dana Lee" írta:'],
    ["no colon", "On Wed, 14 Nov 2018 08:14:43 -0200 Dana Lee <dana@acme.com> wrote"],
    ["Zoho dashes", "---- On Wed, 24 Feb 2021 14:02:50 +0530 dana@acme.com wrote ----"],
  ];
  for (const [name, header] of cases) {
    test(`${name}: own text kept, header and quote removed`, () => {
      const text = `Thursday works for me.\n\n${header}\n\n> ${body}\n> Dana`;
      expect(stripReply(text)).toBe("Thursday works for me.");
      expect(parts(text).find(([, l]) => l === header)?.[0]).toBe(PART_HEADER);
    });
  }

  test("a header wrapped over three lines (Gmail wraps at ~78 columns)", () => {
    const text = `Sounds good.\n\nOn Dec 16, 2011, at 12:47 PM, Corey Donohoe\n<reply@reply.github.com>\nwrote:\n\n> ${body}`;
    expect(stripReply(text)).toBe("Sounds good.");
    expect(parts(text).filter(([k]) => k === PART_HEADER)).toHaveLength(3);
  });

  test("a header wrapped inside the address, ending with a lone '>:' line", () => {
    const text = `Fine.\n\ntir. 18. apr. 2017 kl. 13:09 skrev Test user <test@example.com\n>:\n\n> ${body}`;
    expect(stripReply(text)).toBe("Fine.");
  });

  test("a verb-less header with a time and no '>' below quotes everything after it", () => {
    const text = `Fine.\n\n30.09.2017, 18.30, "John - Doe" <john@doe.com>:\n\n${body}`;
    expect(stripReply(text)).toBe("Fine.");
  });

  test("an unmarked quote (Apple, Outlook, converted HTML): everything below the header is quoted", () => {
    const text = `Thursday works.\n\nOn Oct 27, 2026, at 15:14, Dana Lee <dana@acme.com> wrote:\n\n${body}\n\nDana`;
    const p = parts(text);
    expect(stripReply(text)).toBe("Thursday works.");
    expect(p.filter(([, l]) => l === body)[0]![0]).toBe(PART_QUOTE);
  });

  test("decomposed accents (NFD) still match the French header", () => {
    const text = `Merci pour le retour, je regarde demain.\n\nLe mar. 27 oct. 2026 à 15:14, Dana <d@x.fr> a écrit :\n> ${body}`;
    expect(stripReply(text.normalize("NFD"))).toBe("Merci pour le retour, je regarde demain.".normalize("NFD"));
  });

  test("CRLF line endings", () => {
    const text = `Thursday works for me.\r\n\r\nOn Tue, Oct 27, 2026 at 3:14 PM Dana <d@x.com> wrote:\r\n> ${body}\r\n`;
    expect(stripReply(text)).toBe("Thursday works for me.");
  });
});

describe("splitReply: Outlook blocks, separators, forwards", () => {
  test("Outlook 'From: … Sent: …' block with the underscore rule above it", () => {
    const text = [
      "Sounds good, see you then.",
      "",
      "________________________________",
      "From: Dana Lee <dana@acme.com>",
      "Sent: Tuesday, October 27, 2026 3:14 PM",
      "To: Priya Raman <priya@globex.com>",
      "Subject: Renewal call",
      "",
      body,
    ].join("\n");
    const p = parts(text);
    expect(stripReply(text)).toBe("Sounds good, see you then.");
    expect(p[2]![0]).toBe(PART_HEADER);
    expect(p[8]![0]).toBe(PART_QUOTE);
  });

  test("French Outlook fields ('Envoyé le :'), indented, and a From: value wrapped onto the next line", () => {
    const fr = `Merci, je regarde.\n\n   De : Company <q@company.com>\n   Envoyé le : jeudi 15 décembre 2016 09:35\n   À : a@b.fr\n   Objet : Question\n\n${body}`;
    expect(stripReply(fr)).toBe("Merci, je regarde.");
    const wrapped = `Noted.\n\nFrom: Human Resources\n<a-really-long-automated-email+1234556@hr.com>\nSent: Monday, August 26, 2019 4:37 PM\nTo: A <a@b.com>\n\n${body}`;
    expect(stripReply(wrapped)).toBe("Noted.");
  });

  test("'-----Original Message-----' and its localized forms", () => {
    for (const sep of [
      "-----Original Message-----",
      "-------- Oprindelig besked --------",
      "-----Ursprüngliche Nachricht-----",
    ]) {
      const text = `Approved.\n\n${sep}\nFrom: Dana <d@x.com>\nSent: Tuesday\nTo: P <p@x.com>\n\n${body}`;
      expect(stripReply(text)).toBe("Approved.");
    }
  });

  test("labels and separators above a header block belong to it", () => {
    const text = `Bien reçu.\n\n====\n\nMessage du : 12/12/2016 13:20\nDe : "Company" <q@company.com>\nA : x@y.fr\nSujet : Test\n\n${body}`;
    expect(stripReply(text)).toBe("Bien reçu.");
  });

  test("forwards: Gmail, Apple and the fields under the marker", () => {
    for (const marker of ["---------- Forwarded message ---------", "Begin forwarded message:"]) {
      const text = `FYI\n\n${marker}\nFrom: Dana <d@x.com>\nDate: Tue, Oct 27, 2026\nSubject: Renewal\nTo: P <p@x.com>\n\n${body}`;
      const p = parts(text);
      expect(stripReply(text)).toBe("FYI");
      expect(p.filter(([k]) => k === PART_HEADER).length).toBeGreaterThanOrEqual(5);
      expect(p.find(([, l]) => l === body)![0]).toBe(PART_FORWARD);
    }
  });
});

describe("splitReply: interleaved and bottom-posted replies", () => {
  test("answers between quoted lines stay own text", () => {
    const text = `On Tue, Oct 27, 2026 at 3:14 PM Dana <d@x.com> wrote:\n> Question one?\nAnswer one.\n> Question two?\nAnswer two.`;
    expect(stripReply(text)).toBe("Answer one.\nAnswer two.");
  });

  test("a bottom post keeps the text under the quote", () => {
    const text = `On 04/19/2011 07:10 AM, Roman Tkachenko wrote:\n\n> ${body}\n\nI can do Thursday at 10.`;
    expect(stripReply(text)).toBe("I can do Thursday at 10.");
  });
});

describe("splitReply: signatures, footers, closings, greetings", () => {
  test("'-- ' signature, closing with name, greeting", () => {
    const text =
      "Hi Dana,\n\nThursday works for me.\n\nThanks,\nPriya\n\n-- \nPriya Raman\nHead of Ops | Globex\n+1 415 555 0134";
    const p = parts(text);
    expect(p[0]![0]).toBe(PART_GREETING);
    expect(stripReply(text)).toBe("Thursday works for me.");
    expect(p.filter(([k]) => k === PART_SIGNATURE).map(([, l]) => l)).toEqual([
      "Thanks,",
      "Priya",
      "-- ",
      "Priya Raman",
      "Head of Ops | Globex",
      "+1 415 555 0134",
    ]);
  });

  test("with boilerplate off, greetings, closings and footers stay own text; delimited signatures do not", () => {
    const text = "Hi Dana,\n\nThursday works.\n\nThanks,\nPriya\n\nSent from my iPhone\n\n-- \nPriya Raman";
    const kept = parts(text, false)
      .filter(([k, l]) => k === PART_OWN && l.trim() !== "")
      .map(([, l]) => l);
    expect(kept).toEqual(["Hi Dana,", "Thursday works.", "Thanks,", "Priya", "Sent from my iPhone"]);
  });

  test("mobile footers in several languages", () => {
    for (const footer of [
      "Sent from my iPhone",
      "Sent from TypeApp<http://www.typeapp.com/r?b=2621>",
      "Get Outlook for iOS",
      "Envoyé de mon iPhone",
      "Von meinem iPhone gesendet",
      "Enviado desde mi iPhone",
      "iPhoneから送信",
    ]) {
      expect(stripReply(`Thursday works for me.\n\n${footer}`)).toBe("Thursday works for me.");
    }
  });

  test("a mailing-list footer under '__' and a long disclaimer under '-- ' are signature", () => {
    const list =
      "Thanks for the fix.\n\n__\nriak-users mailing list\nriak-users@lists.basho.com\nhttp://lists.basho.com/mailman/listinfo";
    expect(stripReply(list)).toBe("Thanks for the fix.");
    const disclaimer = ["Approved.", "", "-- ", ...Array.from({ length: 14 }, (_, i) => `Legal line ${i}.`)].join("\n");
    expect(stripReply(disclaimer)).toBe("Approved.");
  });

  test("a closing alone is the message, not its sign-off", () => {
    expect(stripReply("Thank you!")).toBe("Thank you!");
    expect(stripReply("Thanks!\n\nOn Tue, Oct 27, 2026 at 3:14 PM Dana <d@x.com> wrote:\n> Done.")).toBe("Thanks!");
  });

  test("a closing word followed by long content is not a closing", () => {
    const text =
      "Thursday works.\n\nThanks\nfor sending the full breakdown of the renewal pricing with all the regional discounts.";
    expect(stripReply(text)).toBe(text);
  });
});

describe("splitReply: things that are not headers or signatures", () => {
  test("prose that starts with 'On' or mentions 'wrote'", () => {
    for (const text of [
      "On Thursday, I get proper rendering.",
      "On Monday the team will review the contract.\nShe wrote the first draft herself.",
      "Check https://example.com/blog/on-date-someone-wrote-about-parsing, it explains the case.",
      "Blah-blah-blah\nOn blah-blah-blah",
    ]) {
      expect(stripReply(text)).toBe(text);
    }
  });

  test("label lines, markdown rules and dashes in content", () => {
    for (const text of [
      "Agenda:\nNote 1: pricing:\nNote 2: legal:",
      "Here is my analysis:\n\n## Key Points\n----\n\n1. Faster\n\n----\n\nThe dashes are formatting.",
      "I'm writing because of:\n-- first point\n-- second point\n\nPlease check it.",
      "From: the marketing team's point of view, this is fine.\nWe ship Friday.",
    ]) {
      expect(stripReply(text)).toBe(text);
    }
  });

  test("an address with a colon but no time and no quote below is not a header", () => {
    const text = "Please write to the shared inbox <ops@acme.com>:\nthey answer within a day.";
    expect(stripReply(text)).toBe(text);
  });
});

describe("dedupText", () => {
  const original = `Hi Priya,\n\n${body}\n\nThanks,\nDana`;

  test("an acknowledgement reduces to the message it quotes", () => {
    const ack = `Thanks!\n\nOn Tue, Oct 27, 2026 at 3:14 PM Dana Lee <dana@acme.com> wrote:\n\n${original
      .split("\n")
      .map((l) => "> " + l)
      .join("\n")}`;
    expect(dedupText(ack, 6)).toBe(dedupText(original, 6));
    expect(dedupText(ack, 6)).toBe(body);
  });

  test("a bare forward and an 'FYI' forward reduce to the forwarded message", () => {
    for (const note of ["", "FYI\n\n", "See below.\n\n"]) {
      const fwd = `${note}---------- Forwarded message ---------\nFrom: Dana <d@x.com>\nDate: Tue\nSubject: Renewal\nTo: P <p@x.com>\n\n${original}`;
      expect(dedupText(fwd, 6)).toBe(body);
    }
  });

  test("a forward of an ack of an Outlook reply reduces through every level", () => {
    const outlook = `Got it.\n\n-----Original Message-----\nFrom: Dana <d@x.com>\nSent: Tuesday\nTo: P <p@x.com>\n\n${original}`;
    const ack = `Thanks!\n\nOn Tue, Oct 27, 2026 at 3:14 PM Lukas <l@x.com> wrote:\n\n${outlook
      .split("\n")
      .map((l) => "> " + l)
      .join("\n")}`;
    const fwd = `---------- Forwarded message ---------\nFrom: Lukas <l@x.com>\nSubject: Re\n\n${ack}`;
    expect(dedupText(fwd, 6)).toBe(body);
  });

  test("a reply with words of its own is its own words", () => {
    const reply = `Thursday at 10 works, I will bring the revised pricing sheet.\n\nOn Tue, Oct 27, 2026 at 3:14 PM Dana <d@x.com> wrote:\n> ${body}`;
    expect(dedupText(reply, 6)).toBe("Thursday at 10 works, I will bring the revised pricing sheet.");
  });

  test("text with nothing quoted is returned stripped", () => {
    expect(dedupText("ok", 6)).toBe("ok");
    expect(dedupText("", 6)).toBe("");
  });
});

describe("countTerms", () => {
  test("counts terms as the tokenizer starts them; unsegmented scripts count two characters a word", () => {
    expect(countTerms("FYI, see the thread below.")).toBe(5);
    expect(countTerms("don't OPS-142 snake_case")).toBe(3);
    expect(countTerms("")).toBe(0);
    expect(countTerms("共有フォルダにドラフトを置きました")).toBe(9); // 17 characters
    expect(countTerms("Osakaの小さなホテル")).toBe(1 + 4); // osaka + 7 characters
  });
});

describe("splitReply: invariants on random input", () => {
  const pieces = [
    "> quoted",
    ">> nested",
    "On Tue, Oct 27, 2026 at 3:14 PM Dana <d@x.com> wrote:",
    "-- ",
    "__",
    "Thanks,",
    "Dana",
    "Sent from my iPhone",
    "From: Dana <d@x.com>",
    "Sent: Tuesday",
    "-----Original Message-----",
    "---------- Forwarded message ---------",
    "Hi Dana,",
    "plain text line with words",
    "",
    "   ",
    ">:",
    "Le mar. 27 oct. 2026 à 15:14, Dana <d@x.fr> a écrit :",
    "東京の会議は木曜日です",
    "\r",
  ];
  test("lines tile the text, kinds are valid, own output has no quote lines, and nothing throws", () => {
    let x = 99;
    const rnd = (n: number) => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) % n;
    const lines = new ReplyLines(4);
    for (let t = 0; t < 2_000; t++) {
      const text = Array.from({ length: rnd(14) }, () => pieces[rnd(pieces.length)]).join(rnd(5) === 0 ? "\r\n" : "\n");
      const n = splitReply(text, lines, rnd(2) === 0);
      let pos = 0;
      for (let i = 0; i < n; i++) {
        expect(lines.starts[i]).toBe(pos);
        expect(lines.kinds[i]!).toBeLessThanOrEqual(PART_GREETING);
        pos = lines.ends[i]!;
        if (text.charCodeAt(pos) === 13) pos++;
        if (i < n - 1) {
          expect(text.charCodeAt(pos)).toBe(10);
          pos++;
        }
      }
      expect(pos).toBe(text.length);
      for (const l of stripReply(text).split("\n")) {
        const s = l.trim();
        if (s.length > 0 && s !== ">:") expect(s.startsWith(">")).toBe(false);
      }
      expect(typeof dedupText(text, 6)).toBe("string");
    }
  });

  test("results do not depend on earlier calls (module scratch is reset per call)", () => {
    const a = `Thursday works.\n\nOn Tue, Oct 27, 2026 at 3:14 PM Dana <d@x.com> wrote:\n> ${body}`;
    const b = Array.from({ length: 300 }, (_, i) => `line ${i} of a long plain message`).join("\n");
    const first = stripReply(a);
    stripReply(b);
    expect(stripReply(a)).toBe(first);
  });

  test("adversarial inputs stay linear (no regex backtracking blow-up)", () => {
    const inputs = [
      "On Monday the team ".repeat(10_000) + "wrote:",
      Array.from({ length: 5_000 }, (_, i) => `Note ${i}: the agenda item number ${i} is:`).join("\n"),
      Array.from({ length: 5_000 }, (_, i) => `From: person${i} <p${i}@x.com>`).join("\n"),
      ">".repeat(100_000),
      " ".repeat(100_000) + ":",
    ];
    for (const text of inputs) {
      const t0 = performance.now();
      stripReply(text);
      dedupText(text, 6);
      expect(performance.now() - t0).toBeLessThan(2_000);
    }
  });
});
