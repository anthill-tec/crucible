// CR-CRU-046 §S1 — server-side TOON encoding via the official first-party
// library (`@toon-format/toon`). The CR-CRU-005 hand-written subset
// serializer is gone; the spec (https://toonformat.dev) is now the contract,
// emitted in the library's DEFAULT form (indentSize 2, comma delimiter).
// This module is a thin adapter kept so `src/v2.ts`'s call sites are the
// single seam for wire encoding.
import { encode } from "@toon-format/toon";

/** Encode a v2 response payload as official-spec TOON (library defaults). */
export function toToon(obj: Record<string, unknown>): string {
  return encode(obj);
}
