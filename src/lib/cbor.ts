import { Tokenizer } from 'cborg';

/**
 * Minimal, loss-free CBOR tree. Built directly from cborg's tokenizer so that
 * numeric map keys (used by every Blockchain Commons payload), byte strings and
 * tags all survive — `cborg.decode()` would reject or flatten them.
 */
export type CborNode =
  | { kind: 'uint'; value: number | bigint }
  | { kind: 'nint'; value: number | bigint }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'text'; value: string }
  | { kind: 'array'; value: CborNode[] }
  | { kind: 'map'; value: Array<[CborNode, CborNode]> }
  | { kind: 'tag'; tag: number; value: CborNode }
  | { kind: 'float'; value: number }
  | { kind: 'simple'; value: 'true' | 'false' | 'null' | 'undefined' };

export type CborParseResult =
  | { ok: true; node: CborNode; nodeCount: number }
  | { ok: false; error: string };

interface RawToken {
  name: string;
  value: unknown;
}

function tokenize(bytes: Uint8Array): RawToken[] {
  const tokenizer = new Tokenizer(bytes, { allowBigInt: true });
  const tokens: RawToken[] = [];
  let guard = 0;
  while (!tokenizer.done()) {
    if (++guard > bytes.length * 4 + 64) throw new Error('CBOR structure too deep');
    const token = tokenizer.next();
    tokens.push({ name: token.type.name, value: token.value });
  }
  return tokens;
}

/** Parses a CBOR byte string into a tree. Only the first item is consumed. */
export function parseCbor(bytes: Uint8Array): CborParseResult {
  if (bytes.length === 0) return { ok: false, error: 'Empty payload' };

  let tokens: RawToken[];
  try {
    tokens = tokenize(bytes);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  let cursor = 0;
  let count = 0;

  const next = (): RawToken => {
    const token = tokens[cursor];
    if (!token) throw new Error('Unexpected end of CBOR data');
    cursor++;
    count++;
    return token;
  };

  const parseItem = (): CborNode => {
    const token = next();
    switch (token.name) {
      case 'uint':
        return { kind: 'uint', value: token.value as number | bigint };
      case 'negint':
        return { kind: 'nint', value: token.value as number | bigint };
      case 'bytes':
        return { kind: 'bytes', value: token.value as Uint8Array };
      case 'string':
        return { kind: 'text', value: token.value as string };
      case 'float':
        return { kind: 'float', value: token.value as number };
      case 'true':
      case 'false':
      case 'null':
      case 'undefined':
        return { kind: 'simple', value: token.name };
      case 'array': {
        const length = (token.value as number) ?? -1;
        const items: CborNode[] = [];
        if (length < 0) {
          while (tokens[cursor]?.name !== 'break') items.push(parseItem());
          next();
        } else {
          for (let i = 0; i < length; i++) items.push(parseItem());
        }
        return { kind: 'array', value: items };
      }
      case 'map': {
        const length = (token.value as number) ?? -1;
        const entries: Array<[CborNode, CborNode]> = [];
        if (length < 0) {
          while (tokens[cursor]?.name !== 'break') entries.push([parseItem(), parseItem()]);
          next();
        } else {
          for (let i = 0; i < length; i++) entries.push([parseItem(), parseItem()]);
        }
        return { kind: 'map', value: entries };
      }
      case 'tag':
        return { kind: 'tag', tag: Number(token.value), value: parseItem() };
      default:
        throw new Error(`Unsupported CBOR type "${token.name}"`);
    }
  };

  try {
    const node = parseItem();
    return { ok: true, node, nodeCount: count };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += HEX[byte];
  return out;
}

function escapeText(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return out;
}

/** Renders a tree as CBOR diagnostic notation, indented for readability. */
export function toDiagnostic(node: CborNode, indent = ''): string {
  const inner = `${indent}  `;
  switch (node.kind) {
    case 'uint':
    case 'nint':
      return typeof node.value === 'bigint' ? `${node.value}n` : String(node.value);
    case 'bytes':
      return node.value.length === 0 ? "h''" : `h'${toHex(node.value)}'`;
    case 'text':
      return `"${escapeText(node.value)}"`;
    case 'float':
      return Number.isInteger(node.value) ? `${node.value}.0` : String(node.value);
    case 'simple':
      return node.value;
    case 'tag': {
      const body = toDiagnostic(node.value, indent);
      return `${node.tag}(${body})`;
    }
    case 'array': {
      if (node.value.length === 0) return '[]';
      const items = node.value.map((item) => inner + toDiagnostic(item, inner));
      return `[\n${items.join(',\n')}\n${indent}]`;
    }
    case 'map': {
      if (node.value.length === 0) return '{}';
      const entries = node.value.map(
        ([key, value]) => `${inner}${toDiagnostic(key, inner)}: ${toDiagnostic(value, inner)}`,
      );
      return `{\n${entries.join(',\n')}\n${indent}}`;
    }
  }
}

/** Converts to plain JSON-friendly data (bytes become hex strings). */
export function toPlain(node: CborNode): unknown {
  switch (node.kind) {
    case 'uint':
    case 'nint':
      return typeof node.value === 'bigint' ? node.value.toString() : node.value;
    case 'bytes':
      return toHex(node.value);
    case 'text':
      return node.value;
    case 'float':
      return node.value;
    case 'simple':
      return node.value === 'undefined' ? null : node.value === 'null' ? null : node.value === 'true';
    case 'tag':
      return { tag: node.tag, value: toPlain(node.value) };
    case 'array':
      return node.value.map(toPlain);
    case 'map': {
      const object: Record<string, unknown> = {};
      for (const [key, value] of node.value) {
        const keyText = key.kind === 'text' ? key.value : toDiagnostic(key);
        object[keyText] = toPlain(value);
      }
      return object;
    }
  }
}

export function countBytes(node: CborNode): number {
  switch (node.kind) {
    case 'bytes':
      return node.value.length;
    case 'text':
      return node.value.length;
    case 'array':
      return node.value.length;
    case 'map':
      return node.value.length;
    case 'tag':
      return countBytes(node.value);
    default:
      return 0;
  }
}

/** Human labels for the numeric keys used by well-known UR types. */
const FIELD_LABELS: Record<string, Record<number, string>> = {
  'crypto-seed': { 1: 'seed', 2: 'name', 3: 'creation date' },
  'crypto-hdkey': {
    1: 'is master',
    2: 'is private',
    3: 'key data',
    4: 'chain code',
    5: 'use info',
    6: 'origin',
    7: 'children',
    8: 'parent fingerprint',
    9: 'name',
    10: 'note',
  },
  'crypto-account': { 1: 'master fingerprint', 2: 'output descriptor' },
  'crypto-output': {},
  'crypto-key': { 3: 'key data', 4: 'chain code', 6: 'origin', 9: 'name', 10: 'note' },
};

/** Keys whose uint value is a Unix timestamp, per UR type. */
const DATE_KEYS: Record<string, number[]> = {
  'crypto-seed': [3],
};

export interface FieldRow {
  label: string;
  value: string;
  mono?: boolean;
}

/**
 * Produces readable "key: value" rows for a CBOR map payload. Keys with a
 * documented meaning for the UR type get a label, everything else falls back to
 * `field <n>` so unknown types are still readable.
 */
export function describeFields(type: string, node: CborNode): FieldRow[] | null {
  if (node.kind !== 'map') return null;
  const labels = FIELD_LABELS[type] ?? {};

  const rows: FieldRow[] = [];
  for (const [key, value] of node.value) {
    const keyNumber =
      key.kind === 'uint' || key.kind === 'nint' ? Number(key.value) : undefined;
    const label =
      keyNumber !== undefined
        ? (labels[keyNumber] ?? `field ${keyNumber}`)
        : toDiagnostic(key);
    const isDate = keyNumber !== undefined && (DATE_KEYS[type]?.includes(keyNumber) ?? false);
    rows.push({ label, ...formatValue(value, isDate) });
  }
  return rows;
}

function formatTimestamp(seconds: number): string {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return String(seconds);
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function formatValue(node: CborNode, isDate = false): { value: string; mono?: boolean } {
  switch (node.kind) {
    case 'bytes':
      if (node.value.length <= 8) return { value: `h'${toHex(node.value)}'`, mono: true };
      return {
        value: `${node.value.length} bytes · ${toHex(node.value).slice(0, 32)}…`,
        mono: true,
      };
    case 'uint':
    case 'nint': {
      if (isDate) {
        const seconds = Number(node.value);
        if (Number.isFinite(seconds)) return { value: formatTimestamp(seconds) };
      }
      return { value: String(node.value) };
    }
    case 'text':
      return { value: node.value };
    case 'simple':
      return { value: node.value };
    case 'float':
      return { value: String(node.value) };
    case 'tag':
      return { value: `tag ${node.tag}`, mono: true };
    case 'array':
      return { value: `${node.value.length} item${node.value.length === 1 ? '' : 's'}` };
    case 'map':
      return { value: `${node.value.length} field${node.value.length === 1 ? '' : 's'}` };
  }
}

/** True when the bytes decode as clean UTF-8 text. */
export function asPrintableText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  // Reject binary-looking output (control characters other than common whitespace).
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return null;
  return text;
}
