import { UR, UREncoder } from '@ngraveio/bc-ur';
import {
  BarcodeFormat,
  EncodeHintType,
  QRCodeDecoderErrorCorrectionLevel,
  QRCodeWriter,
  type BitMatrix,
} from '@zxing/library';
import { Buffer } from 'buffer';

export interface AnimatorConfig {
  payload: Uint8Array;
  urType: string;
  maxFragmentLength: number;
  fps: number;
}

export interface AnimatorFrame {
  frame: number;
  partCount: number;
  singlePart: boolean;
}

const QR_RENDER_SIZE = 800;
const MAX_CACHED_FRAMES = 300;

/**
 * Renders a payload as an animated sequence of fountain-encoded UR QR codes.
 * Used by the built-in generator so the scanner can be exercised without a
 * second device.
 */
export class UrQrAnimator {
  private readonly context: CanvasRenderingContext2D;
  private readonly writer = new QRCodeWriter();
  private readonly cache = new Map<string, HTMLCanvasElement>();

  private encoder: UREncoder | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private frame = 0;
  private intervalMs = 125;
  private partCount = 1;
  private singlePart = true;

  onFrame: ((frame: AnimatorFrame) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    this.context = context;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Builds a new animated sequence. Throws when the payload cannot fit a QR code. */
  load(config: AnimatorConfig): AnimatorFrame {
    this.stop();
    this.cache.clear();
    this.frame = 0;

    const ur = new UR(Buffer.from(config.payload), config.urType);
    const encoder = new UREncoder(ur, Math.max(10, config.maxFragmentLength));
    this.encoder = encoder;
    this.partCount = encoder.fragmentsLength;
    this.singlePart = this.partCount <= 1;
    this.intervalMs = 1000 / Math.min(20, Math.max(1, config.fps));

    const first = this.renderNext() ?? { frame: 0, partCount: this.partCount, singlePart: this.singlePart };
    return first;
  }

  start(): void {
    if (!this.encoder || this.timer !== null) return;
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Advances one frame without running the timer (single-step debugging). */
  step(): AnimatorFrame | null {
    return this.renderNext();
  }

  private readonly tick = (): void => {
    this.timer = null;
    if (!this.encoder) return;
    const started = performance.now();
    this.renderNext();
    const remaining = Math.max(0, this.intervalMs - (performance.now() - started));
    this.timer = setTimeout(this.tick, remaining);
  };

  private schedule(): void {
    this.timer = setTimeout(this.tick, this.intervalMs);
  }

  private renderNext(): AnimatorFrame | null {
    const encoder = this.encoder;
    if (!encoder) return null;

    const part = encoder.nextPart();
    let bitmap = this.cache.get(part);
    if (!bitmap) {
      bitmap = this.encodeToCanvas(part);
      if (this.cache.size >= MAX_CACHED_FRAMES) this.cache.clear();
      this.cache.set(part, bitmap);
    }

    if (this.canvas.width !== bitmap.width) this.canvas.width = bitmap.width;
    if (this.canvas.height !== bitmap.height) this.canvas.height = bitmap.height;
    this.context.imageSmoothingEnabled = false;
    this.context.drawImage(bitmap, 0, 0);

    this.frame++;
    const frame: AnimatorFrame = {
      frame: this.frame,
      partCount: this.partCount,
      singlePart: this.singlePart,
    };
    this.onFrame?.(frame);
    return frame;
  }

  private encodeToCanvas(text: string): HTMLCanvasElement {
    const hints = new Map<EncodeHintType, unknown>([
      [EncodeHintType.ERROR_CORRECTION, QRCodeDecoderErrorCorrectionLevel.L],
      [EncodeHintType.CHARACTER_SET, 'UTF-8'],
    ]);

    let matrix: BitMatrix;
    try {
      matrix = this.writer.encode(
        text,
        BarcodeFormat.QR_CODE,
        QR_RENDER_SIZE,
        QR_RENDER_SIZE,
        hints as Map<EncodeHintType, never>,
      );
    } catch {
      throw new Error(
        'This payload cannot fit into a single QR code at the chosen fragment size. Reduce the fragment size.',
      );
    }

    const width = matrix.getWidth();
    const height = matrix.getHeight();
    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;

    const context = offscreen.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');

    const image = context.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const on = matrix.get(x, y);
        const offset = (y * width + x) * 4;
        const value = on ? 0 : 255;
        image.data[offset] = value;
        image.data[offset + 1] = value;
        image.data[offset + 2] = value;
        image.data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    return offscreen;
  }
}
