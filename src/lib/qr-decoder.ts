import { BrowserQRCodeReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

export type DecoderEngine = 'native' | 'zxing';

type FrameSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap;

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorCtor;
  }
}

const VIDEO_MAX_DIMENSION = 1280;
const IMAGE_MAX_DIMENSION = 1600;

function hints(tryHarder: boolean): Map<DecodeHintType, unknown> {
  const map = new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]],
    [DecodeHintType.CHARACTER_SET, 'UTF-8'],
  ]);
  if (tryHarder) map.set(DecodeHintType.TRY_HARDER, true);
  return map;
}

function sourceSize(source: FrameSource): { width: number; height: number } {
  if (source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  return { width: source.width, height: source.height };
}

/**
 * Decodes QR payloads from camera frames and still images.
 *
 * Uses the platform `BarcodeDetector` when available (hardware accelerated,
 * much faster on long UR animations) and falls back to ZXing's WASM-free JS
 * decoder everywhere else.
 */
export class QrDecoder {
  readonly engine: DecoderEngine;

  private detector: BarcodeDetectorLike | null = null;
  private fastReader: BrowserQRCodeReader | null = null;
  private thoroughReader: BrowserQRCodeReader | null = null;
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;

  private constructor(engine: DecoderEngine) {
    this.engine = engine;
    const context = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D is unavailable');
    this.context = context;
  }

  static async create(): Promise<QrDecoder> {
    const ctor = window.BarcodeDetector;
    if (ctor?.getSupportedFormats) {
      try {
        const formats = await ctor.getSupportedFormats();
        if (formats.includes('qr_code')) {
          const decoder = new QrDecoder('native');
          decoder.detector = new ctor({ formats: ['qr_code'] });
          return decoder;
        }
      } catch {
        // Fall through to ZXing.
      }
    }
    const decoder = new QrDecoder('zxing');
    decoder.fastReader = new BrowserQRCodeReader(hints(false) as Map<DecodeHintType, never>);
    decoder.thoroughReader = new BrowserQRCodeReader(hints(true) as Map<DecodeHintType, never>);
    return decoder;
  }

  /** Reads a live camera frame. Returns null when no QR code is visible. */
  async decodeVideo(video: HTMLVideoElement): Promise<string | null> {
    if (video.readyState < 2 || video.videoWidth === 0) return null;

    if (this.detector) {
      try {
        const found = await this.detector.detect(video);
        return found[0]?.rawValue ?? null;
      } catch {
        return null;
      }
    }
    return this.decodeCanvas(video, VIDEO_MAX_DIMENSION, false);
  }

  /** Reads a still image, using the more exhaustive ZXing settings. */
  async decodeImage(source: HTMLImageElement | ImageBitmap): Promise<string | null> {
    if (this.detector) {
      try {
        const found = await this.detector.detect(source);
        return found[0]?.rawValue ?? null;
      } catch {
        return null;
      }
    }
    return this.decodeCanvas(source, IMAGE_MAX_DIMENSION, true);
  }

  private decodeCanvas(source: FrameSource, maxDimension: number, thorough: boolean): string | null {
    const reader = thorough ? this.thoroughReader : this.fastReader;
    if (!reader) return null;

    const { width, height } = sourceSize(source);
    if (width === 0 || height === 0) return null;

    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    if (this.canvas.width !== targetWidth) this.canvas.width = targetWidth;
    if (this.canvas.height !== targetHeight) this.canvas.height = targetHeight;

    this.context.drawImage(source, 0, 0, targetWidth, targetHeight);

    try {
      const result = reader.decodeFromCanvas(this.canvas);
      return result.getText() || null;
    } catch {
      return null;
    }
  }
}
