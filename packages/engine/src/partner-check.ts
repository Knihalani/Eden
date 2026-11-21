import { distinctiveTokens, showsUse } from "./usage";
import { termIds } from "./text";
import {} from "./settle";
import { renderAnswer, renderPacket, shownText } from "./render";
import { mentionsOf } from "./partner-core";
import {} from "./partner-freeze";
import { settled } from "./probes";
import {} from "./grounding";
import { itemMark } from "./push-check";
import {} from "./reader";
import { cardKey } from "./cards";
import { type Source } from "@eden/sources";
import { callParties, MAX_CHECKED, namesParty, partyFindingText, partyKey, type Party } from "./parties";
import { type ItemCache } from "./cache";
import {
  itemId,
  newId,
  scopeKey,
  type ActionCheck,
  type AgentEvent,
  type ContextItem,
  type Injection,
  type Scope,
} from "@eden/protocol";
import type { CheckOutcome, Scored, Session } from "./partner";
import {
  CHECK_REUSE_MS,
  MAX_CHECKS,
  MAX_UNVERIFIABLE,
  MAX_UNVERIFIABLE_USERS,
  UPDATED,
  copiesOf,
  renderedCount,
  sessionKey,
  timesOf,
  versionOf,
  within,
} from "./partner";

import { MAX_OUTSTANDING, PartnerDelivery, utf8 } from "./partner-delivery";
/**
 * `ContextPartner`'s check slice (R3, D2020): `checkAction` and the freshness machinery behind the verify step —
 * `check`/`checkAhead`/`checkUsage`/`checkedOut`, the seen/forgotten marks, plan mentions and unverifiable holds.
 * Sits between `PartnerDelivery` and the paths: deliveries enqueue checks and the paths call `checkAction`.
 */

export const UPDATED_TAG = "updated: ";

export const UPDATED_NOTE = " (changed at its source since shown earlier; this version replaces it)";

/** Doubted candidates of a reader's pool re-read beside its call (`checkAhead`): about what a delivery cites. */
export const VERIFY_AHEAD = 3;

export abstract class PartnerCheck extends PartnerDelivery {
  protected abstract queueUpdates(s: Session, changed: readonly ContextItem[]): void;
  protected abstract seen(scope: Scope): void;
  declare protected readonly forgotten: Set<string>;
  protected abstract store(s: Session, items: ContextItem[], parent: number, synced: boolean, readMark: number): number;
  protected abstract dropGone(scope: Scope, sourceId: string, ids: string[]): number;

  /**
   * Items just stored with new or changed words (a sync poll or backfill page, a notice's items, a re-read): every
   * live session of the user that was handed another version of one gets "updated:" packets with the stored copies,
   * queued for its next take. The ledger then holds the new version, so each revision is sent once per session; an
   * earlier update still queued for the same items is replaced. Only real words count (`versionOf`: title and text,
   * not metadata). A copy stored under a later signal is sent all the same: it is newer than what the agent holds, and
   * a newer one still is sent when stored. A re-read for a session's own delivery queues one there too: the delivery
   * may not render the item (a size cut, a fold, a reader that does not pick it); one that does drops the update when
   * it is handed out (`watchCopies`, `withoutCoveredUpdates`).
   */
  protected queueRevised(scope: Scope, items: readonly ContextItem[]): void {
    if (!this.config.revisionNotice || items.length === 0) return;
    const sessions = this.watching.get(scopeKey(scope));
    if (!sessions) return;
    for (const s of sessions) {
      if (s.closed) continue;
      const changed = items.filter((it) => s.ledger.superseded(it.id, versionOf(it)));
      this.queueUpdates(s, changed);
    }
  }

  /**
   * One "updated:" packet: changed items under their titles, prefixed so the agent reads each as a newer version of
   * something it was shown, in the same data envelope as any packet (D11, D19). Only the items the size cut left in
   * are cited, marked delivered in the ledger (the normal paths do not send them again within the cooldown) and
   * returned; at least the first always is. Registered for usage tracking like any packet, with its own copies, so
   * handing out an older packet queued before it cannot leave the ledger at the older version.
   */
  protected buildUpdate(s: Session, items: readonly ContextItem[]): { injection: Injection; items: ContextItem[] } {
    const tagged = items.map((it) => ({ ...it, title: `${UPDATED_TAG}${it.title}${this.updatedNote(s, it)}` }));
    let text = renderPacket(tagged, { maxBytes: this.config.maxInjectionBytes });
    let n = renderedCount(items, text);
    if (n === 0) {
      // Not even the first line fits a tiny `maxInjectionBytes`: it is said alone, under a cap that holds its line.
      text = renderPacket(tagged.slice(0, 1), {
        maxBytes: Math.max(this.config.maxInjectionBytes, 512),
      });
      n = 1;
    }
    const said = items.slice(0, n);
    const id = newId("inj", this.now());
    const injection: Injection = {
      ...s.scope,
      id,
      sessionId: s.id,
      mode: "proactive",
      text,
      citations: this.cited(said),
      reason: `${UPDATED}${id}`,
      score: 1,
      createdAt: this.now(),
    };
    s.ledger.mark(
      said.map((it) => it.id),
      s.turn,
      said.map((it) => versionOf(it)),
    );
    this.built.set(injection, {
      sourceIds: [...new Set(said.map((i) => i.sourceId))],
      items: said.map((i) => ({ sourceId: i.sourceId, id: i.id })),
      text: shownText(text),
      ...(this.config.askDedup ? { shown: { items: said, text } } : {}),
      copies: copiesOf(said, this.config.revisionDiff),
    });
    return { injection, items: said };
  }

  /**
   * How an update's title ends: `UPDATED_NOTE`, and with `revisionDiff` (D342) the times and dates the agent was shown
   * for the item that this version no longer has ("no longer: 09:30"), read before the ledger notes the new copy.
   */
  private updatedNote(s: Session, item: ContextItem): string {
    if (!this.config.revisionDiff) return UPDATED_NOTE;
    const now = new Set(timesOf(item));
    const gone = s.ledger.seenTimes(item.id).filter((t) => !now.has(t));
    return gone.length ? `${UPDATED_NOTE.slice(0, -1)}; no longer: ${gone.join(", ")})` : UPDATED_NOTE;
  }

  protected seenNow(scope: Scope): void {
    this.forgotten.delete(scopeKey(scope));
    const fresh = this.sync?.track(scope, this.now());
    if (fresh && this.config.syncKick) this.sync!.kick(scope);
  }

  /**
   * The party check (`partyCheck`, D375, D376; docs/research/a25-action-guard.md): an agent's tool call, before it
   * runs, checked with no model and no source call for a party (an address, an account) it adds that this session's
   * packets showed, the user's own request does not name and no correspondent of the user's vouches for
   * (`partyFinding`). Anything else proceeds, as does a call to the same tool adding the same parties again after a
   * finding (the agent's informed choice). A finding is data in the usual envelope; what the integration does with it
   * is its own. With the check off, every call proceeds and no state is touched. Never throws: a failure proceeds.
   * (The action firewall that also read the call's grounds, `actionCheck`, D69, was deleted by D815.)
   */
  async checkAction(event: AgentEvent): Promise<ActionCheck> {
    const t0 = performance.now();
    const thawing = this.deps.cache.ready(event); // D325, as in `observe`.
    if (thawing) await thawing;
    const proceed = (reason: string): ActionCheck => ({
      verdict: "proceed",
      finding: null,
      reason,
      latencyMs: Math.round(performance.now() - t0),
    });
    if (!this.config.partyCheck || event.kind !== "tool_call") return proceed("off");
    this.seen(event); // A live party check is a sighting too: the user's agent is working (D2005).
    // A session Eden handed no identifier has nothing to hold, and none is opened for a call in a session Eden never
    // saw.
    if (!this.sessions.get(sessionKey(event))?.packetParties?.size) return proceed("clear");
    try {
      const s = this.session(event);
      // The user's own words only: an arriving message (`external:`) can be the attacker's mail naming the address.
      const said = [...s.window].reverse().find((w) => w.startsWith("user_message: "));
      const found = this.partyFinding(s, event, said ? said.slice("user_message: ".length) : "");
      if (!found) return proceed("clear");
      // A held call's finding is handed to the agent like any injection: track it so the usage record can carry
      // its bytes and a verdict (C1); without this the digest never saw a party finding's text at all.
      const foundTerms = termIds(found.text, s.vocab, true);
      s.outstanding.set(found.id, {
        injectionId: found.id,
        sourceIds: [...new Set(found.citations.map((c) => c.sourceId))],
        situation: s.situation,
        bytes: utf8.encode(found.text).byteLength,
        tokens: distinctiveTokens(foundTerms.ids, foundTerms.n, s.seen, s.vocab),
        deliveredTurn: s.turn,
        warning: true,
      });
      while (s.outstanding.size > MAX_OUTSTANDING) s.outstanding.delete(s.outstanding.keys().next().value as string);
      const latencyMs = Math.round(performance.now() - t0);
      this.trace(s, {
        sessionId: s.id,
        turn: s.turn,
        event: "tool_call",
        decision: "fast",
        reason: "action-party",
        latencyMs,
        sourceCalls: 0,
        modelCalls: 0,
        costUsd: 0,
        itemIds: found.citations.map((c) => c.itemId),
      });
      return { verdict: "finding", finding: found, reason: "party", latencyMs };
    } catch {
      return proceed("error");
    }
  }

  /**
   * `partyCheck` (D375): a finding when the call adds a party (`callParties`) that this session's packets showed
   * (`Session.packetParties`), that the request does not name, and that is no correspondent of the user's
   * (`ItemCache.isCorrespondent`, addresses only, the item that showed it never vouching for it: an account number
   * has no header line to be on). Null otherwise. The tool and the flagged parties are remembered, so a call to the
   * same tool adding them again proceeds. `request` is the session's latest user message.
   */
  private partyFinding(s: Session, event: AgentEvent & { kind: "tool_call" }, request: string) {
    const shown = s.packetParties;
    if (!shown || shown.size === 0) return null;
    const flagged: Party[] = [];
    const ids = new Set<string>();
    for (const p of callParties(event.input)) {
      const from = shown.get(partyKey(p.norm));
      if (from === undefined) continue;
      if (namesParty(request, p)) continue;
      if (p.kind === "address" && this.deps.cache.isCorrespondent(s.scope, p.norm, from || undefined)) continue;
      flagged.push(p);
      if (from) ids.add(from);
    }
    if (flagged.length === 0) return null;
    // The agent was told about these parties for this tool: a call adding them again proceeds, whatever else changed
    // in it (a fresh request id, a reworded body after the user said yes).
    const informed = `party\u0000${event.tool}\u0000${flagged
      .map((p) => partyKey(p.norm))
      .sort()
      .join(",")}`;
    const checked = (s.checked ??= new Set());
    if (checked.has(informed)) return null;
    checked.add(informed);
    while (checked.size > MAX_CHECKED) checked.delete(checked.values().next().value as string);
    const items = [...ids]
      .map((id) => this.deps.cache.get(s.scope, id, this.now()))
      .filter((i): i is ContextItem => i !== null);
    const citations = this.cited(items);
    const text = renderAnswer(
      partyFindingText(
        event.tool,
        flagged,
        citations.map((c) => c.title),
      ),
    );
    const finding: Injection = {
      ...s.scope,
      id: newId("inj", this.now()),
      sessionId: s.id,
      mode: "proactive",
      text,
      citations,
      reason: "action-party",
      score: 1,
      createdAt: this.now(),
    };
    return finding;
  }

  /**
   * `packetHeedsCheck` (G2, D1450): the test of whether this request's push check read an item and did not say yes
   * to it, or null when no settled check of this request did. An item counts only as the copy the check read
   * (`itemMark`'s id and content hash): a changed copy is not the one it turned down.
   */
  protected checkedOut(s: Session): ((item: ContextItem) => boolean) | null {
    if (!this.config.packetHeedsCheck || !s.pushChecks) return null;
    const out = new Map<string, string>();
    for (const kept of s.pushChecks.values()) {
      const read = kept.settled;
      if (kept.request !== s.requests || !read?.yes) continue;
      // A reply that named its most (5) may have left out items it would have named: it turned nothing down.
      if (read.yes.size + (read.rules?.size ?? 0) >= 5) continue;
      // A rule the reply named brings its item in too (`pushCheckSheet`): that is a yes.
      for (const [id, mark] of kept.marks) {
        if (read.yes.has(id) || read.rules?.has(id)) out.delete(id);
        else out.set(id, mark);
      }
    }
    if (out.size === 0) return null;
    return (item) => out.get(item.id)?.startsWith(`${item.id}\t${cardKey(item)}\t`) === true;
  }

  protected checkUsage(s: Session, event: AgentEvent, terms: Uint32Array): void {
    const actsOnIt = event.kind === "agent_message" || event.kind === "tool_call";
    if (s.outstanding.size === 0) return;
    for (const [id, o] of s.outstanding) {
      // A warning's terms are the blocked call's own: a matching tool_call is the call it warned
      // about retried, not use — only the agent's words can credit it.
      const used = actsOnIt && !(o.warning && event.kind === "tool_call") && showsUse(terms, o.tokens, s.vocab);
      const expired = s.turn - o.deliveredTurn > this.config.usageWindowTurns;
      if (!used && !expired) continue;
      s.outstanding.delete(id);
      const how = used ? "inferred" : "expired";
      this.record(s.scope, id, o.sourceIds, o.situation, used, { sessionId: s.id, how, bytes: o.bytes });
    }
  }

  /** Records the entity mentions of items new to the user's cache or changed (lookups and the sync, D57). */
  protected recordMentions(
    scope: Scope,
    added: ContextItem[],
    parent = 0,
    given?: { sourceId: string; entities: string[] }[],
  ): void {
    if (added.length === 0) return;
    const spans = this.spans;
    const noting = spans?.open("mentions", parent, { items: added.length });
    const mentions = given ?? mentionsOf(added);
    if (mentions.length > 0) this.deps.sourceMap.recordMentionsMany(scope, mentions, this.now());
    if (noting) spans!.close(noting);
  }

  /** Notes an "unverifiable" re-read of a user's item under the read mark it began with (`unverifiable`). */
  private noteUnverifiable(scope: Scope, id: string, readMark: number): void {
    const key = scopeKey(scope);
    let user = this.unverifiable.get(key);
    if (user) this.unverifiable.delete(key);
    else user = new Map();
    this.unverifiable.set(key, user);
    user.delete(id);
    user.set(id, { mark: readMark, at: this.now() });
    while (user.size > MAX_UNVERIFIABLE) user.delete(user.keys().next().value as string);
    while (this.unverifiable.size > MAX_UNVERIFIABLE_USERS)
      this.unverifiable.delete(this.unverifiable.keys().next().value as string);
  }

  /**
   * One item's re-read (`verifyDelivery`), shared by every delivery of the session that wants it while it runs or for
   * `CHECK_REUSE_MS` after: started ahead (`checkAhead`, beside the reader's call) or by `verifyItems`. A changed copy
   * is stored, a gone item dropped from the cache and the sync's bookkeeping. Never throws. `made` counts the call of
   * a re-read this starts (not one it joins).
   */
  protected check(s: Session, item: ContextItem, made?: { calls: number }): Promise<CheckOutcome> {
    // A ref notice is re-reading this item now (D347): its outcome, with no second call.
    const refreshing = this.refreshing.size > 0 ? this.refreshing.get(`${scopeKey(s.scope)}|${item.id}`) : undefined;
    // Not past a signal that came after the notice: that read may have answered before the newer change.
    if (refreshing && this.sync?.signalledSince(s.scope, item.sourceId, refreshing.mark) !== true) {
      // Waited on no longer than a re-read of its own would be (`verifyTimeoutMs`): past it, not confirmed.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<CheckOutcome>(
        (r) => (timer = setTimeout(() => r("failed"), this.config.verifyTimeoutMs)),
      );
      return Promise.race([refreshing.outcome, late]).finally(() => clearTimeout(timer));
    }
    const checks = (s.checks ??= new Map());
    const now = this.now();
    const held = checks.get(item.id);
    // Reused while it runs, or for a while after if it settled; never past a newer signal, and never a failure.
    if (
      held &&
      now - held.at <= CHECK_REUSE_MS &&
      held.settled !== "failed" &&
      held.settled !== "flaked" &&
      held.settled !== "skipped" &&
      this.sync?.signalledSince(s.scope, item.sourceId, held.mark) !== true
    )
      return held.outcome;
    // The read mark before the re-read's call (D133): a signal while it is on the wire doubts what it stores, and
    // refuses its reuse.
    const mark = this.sync?.mark() ?? 0;
    const entry: { at: number; mark: number; outcome: Promise<CheckOutcome>; settled?: CheckOutcome } = {
      at: now,
      mark,
      outcome: this.recheck(s, item, mark, made).then((o) => (entry.settled = o)),
    };
    const outcome = entry.outcome;
    checks.delete(item.id);
    checks.set(item.id, entry);
    while (checks.size > MAX_CHECKS) checks.delete(checks.keys().next().value as string);
    return outcome;
  }

  private async recheck(
    s: Session,
    item: ContextItem,
    readMark: number,
    made: { calls: number } = { calls: 0 },
  ): Promise<CheckOutcome> {
    this.freshness.checked++;
    try {
      const all = await this.deps.sources(s.scope).catch((): Source[] => []);
      const source = all.find((x) => x.id === item.sourceId);
      if (!source?.fetch) {
        this.freshness.failed++;
        return "unverifiable";
      }
      this.freshness.calls++;
      made.calls++;
      const got = await this.fanout.fetchChecked(source, s.scope, item.ref, {
        timeoutMs: this.config.verifyTimeoutMs,
        signal: s.abort.signal,
      });
      if (got.status === "failed" || s.closed) {
        this.freshness.failed++;
        if (s.closed || got.status !== "failed") return "failed";
        // A guard's skip made no call: not one the connector received. A busy permit or our rate limit's ordinary use
        // is no evidence against the item and clears in moments (one retry). An open breaker, or a rate limit the
        // connector's own 429 pushed back, says the source is in trouble now: the item could not be checked
        // ("failed"), so a strict ask leaves it out and says so (D211, D232).
        if (got.why === "refused") {
          this.freshness.calls--;
          made.calls--;
          return got.guard === "open" || got.pushedBack ? "failed" : "skipped";
        }
        // A null from a source whose null does not mean gone (an MCP tool) says nothing, and says it every time: like
        // a source with no fetch, its items are cited as held (D126). A plain error is worth one more read.
        // A null whose reply lacked the record says the same next time: held (D298). An error result may pass: not.
        if (got.why === "null" && !s.closed) this.noteUnverifiable(s.scope, item.id, readMark);
        if (got.why === "null" || got.why === "error-result") return "unverifiable";
        return got.why === "error" ? "flaked" : "failed";
      }
      if (got.status === "gone") {
        this.freshness.gone++;
        this.dropGone(s.scope, item.sourceId, [item.id]);
        return "gone";
      }
      // A removal that landed while the fetch was on the wire (`sourceRemoved`) wins over what it read: the id was a
      // cached candidate when the re-read began, and `removeItems` drops what it holds gone, so a live hold now means
      // the deletion came after. Reviving it would undo the deletion and deliver it (D126).
      if (this.deps.cache.isHeldGone(s.scope, item.id, this.now())) {
        this.freshness.gone++;
        return "gone";
      }
      const copy = { ...got.item, id: item.id, sourceId: item.sourceId, ref: item.ref };
      this.deps.cache.revive(s.scope, [item.id]);
      // Found at its source: a sweep that missed it skipped it (an offset listing shifts), D356's doubt is answered.
      this.sync?.vouched(s.scope, item.sourceId, item.id);
      const synced = this.deps.cache.isSynced(s.scope, item.id);
      // Stored as read now (its fetch time moves), as synced when the sync held it; carded and noted like any read.
      const changed = this.store(s, [copy], 0, synced, readMark) > 0;
      // A held search page may still show the old copy: a later lookup must not store it back.
      if (changed) this.fanout.dropResults(s.scope, item.sourceId);
      if (changed) {
        const stored = this.deps.cache.get(s.scope, item.id, this.now());
        if (stored) this.queueRevised(s.scope, [stored]);
      }
      if (changed) this.freshness.changed++;
      else this.freshness.confirmed++;
      return changed ? "changed" : "confirmed";
    } catch {
      // Never throws: a re-read started ahead is not awaited (`checkAhead`), and its outcome is shared.
      this.freshness.failed++;
      return "failed";
    }
  }

  /**
   * `verifyDelivery`: re-reads the first `VERIFY_AHEAD` doubted candidates of a reader's pool while the reader reads
   * them, so the delivery that follows finds them done (`check`) instead of waiting a connector's round trip. The
   * reader reads the copies it was given; a delivery shows the re-read ones.
   */
  protected checkAhead(s: Session, pool: readonly Scored[]): void {
    if (!this.config.verifyDelivery) return;
    let n = 0;
    for (const x of pool) {
      if (n >= VERIFY_AHEAD) break;
      if (!this.doubted(s, x.item)) continue;
      n++;
      void this.check(s, x.item);
    }
  }
}
