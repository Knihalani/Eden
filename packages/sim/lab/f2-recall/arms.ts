/**
 * F2's screened instructions: each arm is the shipped `CHECK_SYSTEM` with named sentences replaced, so an arm's
 * difference is exactly its replacements (a replacement that does not match throws).
 */
import { CHECK_SYSTEM } from "@eden/engine";

const OLD_ACT =
  'Then "act": true only if "hits" is not none and the item gives a reason to stop, to check first or to do it ' +
  "another way; false for a go-ahead (approved, lifted, back to normal, no longer applies), for background and " +
  'whenever "hits" is none. ';

/** A: the act rule says what a go-ahead is not: the request's own job already done, or its day already taken. */
const ACT_A =
  'Then "act": true if "hits" is not none and the item gives a reason to stop, to check first or to do it another ' +
  "way. That includes the request's own job already done, paid, renewed, fixed, resolved, booked or sent by " +
  "someone (doing it again would be wasted or wrong), and a closure, absence or other plan that covers the " +
  "request's day or time. false for a go-ahead, which removes an obstacle and leaves the request still to do (a " +
  'hold lifted, an approval for it granted, back to normal), for background and whenever "hits" is none. ';

/** R: A, plus facts about the request's people, short notices and an explicit lean when unsure. */
const ACT_R =
  ACT_A.slice(0, ACT_A.indexOf(" false for a go-ahead")) +
  " So does a fact about a person in the request that a careful assistant would weigh (a health need, an " +
  "allergy, a pregnancy, a sensitivity), and a short notice to a group the user is in (their building, street, " +
  "team, class or club) about a shared thing the request uses or a time it falls in (a lift, parking, a room, " +
  "access, a closure), even when the request does not name it. An item can be one line of chat or a portal " +
  "notice: weigh it as you would a letter." +
  ACT_A.slice(ACT_A.indexOf(" false for a go-ahead")) +
  "When an item lands on the request and you are unsure whether it changes what to do, write true: the assistant " +
  "reads every item you name and sets aside one that does not bear, while an item you leave out is lost to it. ";

const swap = (from: string, to: string) => {
  if (!CHECK_SYSTEM.includes(from)) throw new Error("arms.ts: a replaced sentence is not in CHECK_SYSTEM");
  return CHECK_SYSTEM.replace(from, to);
};

export const ARM_SYSTEMS: Record<string, string> = {
  A: swap(OLD_ACT, ACT_A),
  R: swap(OLD_ACT, ACT_R),
};
