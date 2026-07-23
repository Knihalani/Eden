"use client";

/**
 * Confirm dialog stub — full UI returns after design gates.
 */
export function useConfirm() {
  return async (message: string): Promise<boolean> => {
    if (typeof window === "undefined") return false;
    return window.confirm(message);
  };
}
