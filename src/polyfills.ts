import { Buffer } from 'buffer';

// `@ngraveio/bc-ur` (and its CJS dependencies) expect Node's Buffer global.
const target = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
  process?: { env: Record<string, string | undefined> };
};

if (!target.Buffer) target.Buffer = Buffer;
if (!target.process) target.process = { env: {} };
