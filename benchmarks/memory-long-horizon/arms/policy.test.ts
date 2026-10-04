/** The gate for the policy arms (A5 §4, G1): each state as `arms.json` records it. */
import { gate } from "./gate";

gate(["policy-guard", "guard-modes", "guard-dedup", "policy-recur", "intent-expiry"]);
