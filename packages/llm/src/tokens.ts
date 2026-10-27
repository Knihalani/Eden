/** A cheap token estimate (about four characters a token) for budgeting before a call. Never for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
