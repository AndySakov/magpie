// Trakt redirects to /trakt/callback after sign-in. Read the result once at startup and move to the Imports tab,
// which finishes the connection. Must run before App reads the tab from the URL.
const params = location.pathname === "/trakt/callback" ? new URLSearchParams(location.search) : null
if (params) history.replaceState(null, "", "/#/imports")

let pending: { readonly code: string; readonly state: string } | { readonly error: string } | null =
  params === null
    ? null
    : params.get("code") && params.get("state")
      ? { code: params.get("code")!, state: params.get("state")! }
      : { error: params.get("error") === "access_denied" ? "Trakt sign-in was cancelled." : "Trakt didn't finish signing in. Try again." }

export const takeTraktReturn = () => {
  const p = pending
  pending = null
  return p
}
