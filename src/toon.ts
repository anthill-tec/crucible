// CR-CRU-005 §S1 — Crucible TOON subset serializer.
//
// Emits exactly four constructs: scalar lines, nested-object indentation,
// uniform-table arrays, and list arrays. The normative wire spec (pinned for
// the crucible fleet) lives in docs/research/DN-crucible-toon-subset.md.

type Scalar = string | number | boolean | null;

/** Scalar strings containing any of `\n : , { } [ ]` are JSON-quoted. */
const SCALAR_SPECIALS = /[\n:,{}[\]]/;

/** Table cells containing any of `" , \n` are JSON-quoted. */
const CELL_SPECIALS = /["\n,]/;

function isScalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function scalarText(value: Scalar): string {
  if (typeof value === "string") {
    return SCALAR_SPECIALS.test(value) ? JSON.stringify(value) : value;
  }
  return String(value);
}

function cellText(value: Scalar): string {
  if (typeof value === "string") {
    return CELL_SPECIALS.test(value) ? JSON.stringify(value) : value;
  }
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Table form requires a non-empty array of plain objects with an identical,
 * order-identical key-set and scalar-only values.
 */
function isUniformTable(items: unknown[]): items is Record<string, Scalar>[] {
  const first = items[0];
  if (!isPlainObject(first)) return false;
  const cols = Object.keys(first);
  if (cols.length === 0) return false;
  return items.every((item) => {
    if (!isPlainObject(item)) return false;
    const keys = Object.keys(item);
    return (
      keys.length === cols.length &&
      keys.every((key, i) => key === cols[i] && isScalar(item[key]))
    );
  });
}

export function toToon(obj: Record<string, unknown>, indent = 0): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (isScalar(value)) {
      lines.push(`${pad}${key}: ${scalarText(value)}`);
    } else if (Array.isArray(value)) {
      if (value.length > 0 && isUniformTable(value)) {
        const first = value[0] as Record<string, Scalar>;
        const cols = Object.keys(first);
        lines.push(`${pad}${key}[${value.length}]{${cols.join(",")}}:`);
        for (const row of value) {
          lines.push(`${pad}  ${cols.map((col) => cellText(row[col] as Scalar)).join(",")}`);
        }
      } else {
        lines.push(`${pad}${key}[${value.length}]:`);
        for (const item of value) {
          if (isScalar(item)) {
            lines.push(`${pad}  ${scalarText(item)}`);
          } else if (isPlainObject(item)) {
            const block = toToon(item, indent + 1);
            if (block) lines.push(block);
          } else {
            lines.push(`${pad}  ${JSON.stringify(item)}`);
          }
        }
      }
    } else if (isPlainObject(value)) {
      lines.push(`${pad}${key}:`);
      const block = toToon(value, indent + 1);
      if (block) lines.push(block);
    }
  }
  return lines.join("\n");
}
