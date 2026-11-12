import { UREncoder, URDecoder } from '@ngraveio/bc-ur';

export interface UrProgress {
  type: string;
  /** Distinct fountain fragments recovered so far. */
  received: number;
  /** Fragments the decoder expects in total (0 until the first frame arrives). */
  expected: number;
  /** Estimated completion, 0..1. */
  percent: number;
  /** QR frames that advanced the decode (duplicates excluded). */
  accepted: number;
}

export interface UrResult {
  type: string;
  payload: Uint8Array;
  accepted: number;
  singlePart: boolean;
  /** Re-encoded single-part UR, when the payload is small enough to be one QR code. */
  uri: string | null;
  durationMs: number;
}

export type UrAttempt =
  | { kind: 'not-ur' }
  | { kind: 'other-type'; type: string }
  | { kind: 'progress'; progress: UrProgress; advanced: boolean }
  | { kind: 'complete'; result: UrResult }
  | { kind: 'error'; message: string; fatal: boolean };

/** UR strings above this size cannot be rendered as a single QR code (v40 caps at 2953 bytes). */
const MAX_SINGLE_PART_PAYLOAD = 2048;

/**
 * Wraps URDecoder with the bookkeeping a scanner UI needs: duplicate frame
 * detection, type tracking, progress estimates and timing.
 */
export class UrSession {
  private decoder = new URDecoder();
  private seen = new Set<string>();
  private accepted = 0;
  private startedAt = 0;
  private finishedAt = 0;
  private result: UrResult | null = null;
  private activeType: string | null = null;

  get isComplete(): boolean {
    return this.result !== null;
  }

  get type(): string | null {
    return this.activeType;
  }

  get currentResult(): UrResult | null {
    return this.result;
  }

  reset(): void {
    this.decoder = new URDecoder();
    this.seen.clear();
    this.accepted = 0;
    this.startedAt = 0;
    this.finishedAt = 0;
    this.result = null;
    this.activeType = null;
  }

  /** Feeds one decoded QR payload into the fountain decoder. */
  receive(raw: string): UrAttempt {
    if (this.result) return { kind: 'complete', result: this.result };

    const text = raw.trim();
    if (!text) return { kind: 'not-ur' };

    let type: string;
    try {
      [type] = URDecoder.parse(text);
    } catch {
      // Not a UR path at all (or a syntactically broken one).
      return /^ur:/i.test(text)
        ? { kind: 'error', message: 'Malformed UR path', fatal: false }
        : { kind: 'not-ur' };
    }

    if (this.activeType === null) this.activeType = type;
    else if (this.activeType !== type) return { kind: 'other-type', type };

    const key = text.toLowerCase();
    if (this.seen.has(key)) return { kind: 'progress', progress: this.snapshot(), advanced: false };
    this.seen.add(key);

    if (this.startedAt === 0) this.startedAt = performance.now();

    try {
      const accepted = this.decoder.receivePart(text);
      if (this.decoder.isError()) {
        return {
          kind: 'error',
          message: this.decoder.resultError() || 'Decoding failed',
          fatal: true,
        };
      }
      if (accepted) this.accepted++;
      if (this.decoder.isSuccess()) return { kind: 'complete', result: this.finish() };
      return { kind: 'progress', progress: this.snapshot(), advanced: accepted };
    } catch (error) {
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not read UR frame',
        fatal: false,
      };
    }
  }

  private snapshot(): UrProgress {
    return {
      type: this.activeType ?? 'ur',
      received: this.decoder.receivedPartIndexes().length,
      expected: this.decoder.expectedPartCount(),
      percent: clampPercent(this.decoder.estimatedPercentComplete()),
      accepted: this.accepted,
    };
  }

  private finish(): UrResult {
    this.finishedAt = performance.now();
    const ur = this.decoder.resultUR();
    const payload = Uint8Array.from(ur.cbor);

    let uri: string | null = null;
    if (payload.length <= MAX_SINGLE_PART_PAYLOAD) {
      try {
        uri = UREncoder.encodeSinglePart(ur);
      } catch {
        uri = null;
      }
    }

    this.result = {
      type: ur.type,
      payload,
      accepted: this.accepted,
      singlePart: this.accepted <= 1,
      uri,
      durationMs: this.startedAt ? this.finishedAt - this.startedAt : 0,
    };
    return this.result;
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
