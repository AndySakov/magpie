import type { User } from "@magpie/contract"
import { createContext, useContext } from "react"
import type { PreferencesInput } from "./api"

export type Session = {
  readonly user: User
  readonly prefs: PreferencesInput
  readonly savePrefs: (update: (prev: PreferencesInput) => PreferencesInput) => Promise<void>
  readonly signOut: () => void
  readonly pulseHoard: () => void
}

export const SessionContext = createContext<Session | null>(null)

export const useSession = (): Session => {
  const session = useContext(SessionContext)
  if (!session) throw new Error("useSession outside SessionContext")
  return session
}
