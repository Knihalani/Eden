/**
 * Shared "is the user typing?" check for global hotkeys.
 * Letter shortcuts must no-op while focus is in a field (R038).
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  if (target.closest("[contenteditable=true]")) return true;
  const role = target.getAttribute("role");
  if (role === "textbox" || role === "searchbox" || role === "combobox") {
    return true;
  }
  return Boolean(target.closest('[role="textbox"], [role="searchbox"]'));
}
