// Shared PIN storage helpers — used by the sign-in page, the app shell, the
// settings shell and the admin API layer. The admin API clears the stored PIN
// on 403/429 so a rejected/expired session returns to the sign-in form
// instead of leaving the app stuck on "Loading console…" forever.

export const PIN_STORAGE_KEY = "freebuff_admin_pin";

export function readStoredPin(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = window.localStorage.getItem(PIN_STORAGE_KEY);
  return value?.trim() || undefined;
}

export function clearStoredPin() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(PIN_STORAGE_KEY);
}
