/**
 * F2's screened instructions (docs/research/f2-push-recall.md): the shipped `CHECK_SYSTEM` with its act rule
 * replaced. A: "already done" and a clash covering the request's day are reasons to stop. R: A, plus person facts,
 * short group notices and a lean to yes when unsure. The engine's trial `pushCheckRecall` held them as forms 1 and 2
 * (deleted by D1141; its code is in commit 35da9420).
 */
import { CHECK_SYSTEM } from "@eden/engine";

const OLD_ACT =
  'true only if "hits" is not none and the item gives a reason to stop, to check first or to do it another way; ' +
  "false for a go-ahead (approved, lifted, back to normal, no longer applies), for background and whenever " +
  '"hits" is none. ';

const ACT_A =
  'true if "hits" is not none and the item gives a reason to stop, to check first or to do it another way. That ' +
  "includes the request's own job already done, paid, renewed, fixed, resolved, booked or sent by someone (doing it " +
  "again would be wasted or wrong), and a closure, absence or other plan that covers the request's day or time. " +
  "false for a go-ahead, which removes an obstacle and leaves the request still to do (a hold lifted, an approval for " +
  'it granted, back to normal), for background and whenever "hits" is none. ';

const ACT_R =
  ACT_A.slice(0, ACT_A.indexOf("false for a go-ahead")) +
  "So does a fact about a person in the request that a careful assistant would weigh (a health need, an allergy, a " +
  "pregnancy, a sensitivity), and a short notice to a group the user is in (their building, street, team, class or " +
  "club) about a shared thing the request uses or a time it falls in (a lift, parking, a room, access, a closure), " +
  "even when the request does not name it. An item can be one line of chat or a portal notice: weigh it as you " +
  "would a letter. " +
  ACT_A.slice(ACT_A.indexOf("false for a go-ahead")) +
  "When an item lands on the request and you are unsure whether it changes what to do, write true: the assistant " +
  "reads every item you name and sets aside one that does not bear, while an item you leave out is lost to it. ";

const swap = (to: string) => {
  if (!CHECK_SYSTEM.includes(OLD_ACT)) throw new Error("arms.ts: the shipped act rule is not in CHECK_SYSTEM");
  return CHECK_SYSTEM.replace(OLD_ACT, to);
};

export const ARM_SYSTEMS: Record<string, string> = { A: swap(ACT_A), R: swap(ACT_R) };
