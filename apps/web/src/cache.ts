import { Schema } from "effect"

/**
 * Last-known server data in localStorage, so the app can paint before the network answers. Reads decode through the
 * contract schemas: a value written by an older client that no longer fits is dropped, not trusted.
 */
export const readCache = <S extends Schema.Top>(key: string, schema: S): S["Type"] | null => {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? null : (Schema.decodeUnknownSync(schema as never)(JSON.parse(raw)) as S["Type"])
  } catch {
    forget(key)
    return null
  }
}

export const writeCache = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: the app still works, it just starts cold next time.
  }
}

export const forget = (key: string) => {
  try {
    localStorage.removeItem(key)
  } catch {
    // Nothing to clear.
  }
}

export const forgetAll = () => {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith("magpie:")) localStorage.removeItem(key)
  } catch {
    // Nothing to clear.
  }
}
