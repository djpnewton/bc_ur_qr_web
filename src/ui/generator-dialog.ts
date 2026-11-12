import * as cborg from 'cborg';
import { UrQrAnimator, type AnimatorFrame } from '../lib/qr-generator';
import { must } from './dom';

type Preset = 'seed16' | 'seed32' | 'text' | 'hex' | 'file';

function fromHex(text: string): Uint8Array | null {
  const cleaned = text.replace(/^0x/i, '').replace(/[\s:]/g, '');
  if (cleaned.length === 0 || cleaned.length % 2 !== 0 || /[^0-9a-f]/i.test(cleaned)) return null;
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Wires the "Test generator" dialog: builds a CBOR payload, fountain-encodes it
 * and animates the resulting QR frames on a canvas.
 */
export class GeneratorDialog {
  private readonly dialog = must<HTMLDialogElement>('generator-dialog');
  private readonly canvas = must<HTMLCanvasElement>('gen-canvas');
  private readonly preset = must<HTMLSelectElement>('gen-preset');
  private readonly inputField = must<HTMLElement>('gen-input-field');
  private readonly inputLabel = must<HTMLElement>('gen-input-label');
  private readonly input = must<HTMLTextAreaElement>('gen-input');
  private readonly fileField = must<HTMLElement>('gen-file-field');
  private readonly file = must<HTMLInputElement>('gen-file');
  private readonly typeInput = must<HTMLInputElement>('gen-type');
  private readonly frag = must<HTMLSelectElement>('gen-frag');
  private readonly fps = must<HTMLSelectElement>('gen-fps');
  private readonly meta = must<HTMLElement>('gen-meta');
  private readonly frameLabel = must<HTMLElement>('gen-frame');
  private readonly playButton = must<HTMLButtonElement>('gen-play');
  private readonly restartButton = must<HTMLButtonElement>('gen-restart');
  private readonly error = must<HTMLElement>('gen-error');

  private readonly animator = new UrQrAnimator(this.canvas);
  private payload: Uint8Array | null = null;
  private playing = false;
  private rebuildTimer = 0;

  constructor() {
    this.animator.onFrame = (frame) => this.showFrame(frame);

    this.preset.addEventListener('change', () => this.applyPreset());
    this.input.addEventListener('input', () => this.scheduleRebuild());
    this.typeInput.addEventListener('change', () => this.scheduleRebuild());
    this.frag.addEventListener('change', () => this.rebuild());
    this.fps.addEventListener('change', () => this.rebuild());
    this.file.addEventListener('change', () => void this.loadFile());

    this.playButton.addEventListener('click', () => this.togglePlay());
    this.restartButton.addEventListener('click', () => this.rebuild());
    this.dialog.addEventListener('close', () => {
      this.animator.stop();
      this.playing = false;
      this.playButton.textContent = 'Play';
    });
  }

  open(): void {
    if (!this.dialog.open) this.dialog.showModal();
    this.applyPreset();
  }

  private applyPreset(): void {
    const preset = this.preset.value as Preset;
    this.error.hidden = true;

    if (preset === 'seed16' || preset === 'seed32') {
      const length = preset === 'seed16' ? 16 : 32;
      const seed = new Uint8Array(length);
      crypto.getRandomValues(seed);
      this.payload = cborg.encode(
        new Map<number, unknown>([
          [1, seed],
          [2, 'UR Scanner demo'],
          [3, Math.floor(Date.now() / 1000)],
        ]),
      );
      this.typeInput.value = 'crypto-seed';
      this.inputField.hidden = true;
      this.fileField.hidden = true;
    } else if (preset === 'text' || preset === 'hex') {
      this.typeInput.value = 'bytes';
      this.inputField.hidden = false;
      this.fileField.hidden = true;
      this.inputLabel.textContent = preset === 'text' ? 'Text' : 'Hex';
      this.input.placeholder =
        preset === 'text' ? 'Hello, Uniform Resource' : '48656c6c6f2c205552';
      this.payload = this.payloadFromInput(preset);
    } else {
      this.typeInput.value = 'bytes';
      this.inputField.hidden = true;
      this.fileField.hidden = false;
      this.payload = null;
    }

    this.rebuild();
  }

  private payloadFromInput(preset: 'text' | 'hex'): Uint8Array | null {
    const value = this.input.value;
    if (preset === 'text') {
      if (!value) return null;
      return cborg.encode(value);
    }
    const bytes = fromHex(value);
    return bytes ? cborg.encode(bytes) : null;
  }

  private scheduleRebuild(): void {
    window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => {
      const preset = this.preset.value;
      if (preset === 'text' || preset === 'hex') {
        this.payload = this.payloadFromInput(preset);
      }
      this.rebuild();
    }, 280);
  }

  private async loadFile(): Promise<void> {
    const file = this.file.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    this.payload = cborg.encode(new Uint8Array(buffer));
    this.rebuild();
  }

  private rebuild(): void {
    window.clearTimeout(this.rebuildTimer);
    this.error.hidden = true;
    this.animator.stop();
    this.playing = false;

    const payload = this.payload;
    if (!payload || payload.length === 0) {
      this.frameLabel.textContent = 'idle';
      this.meta.textContent =
        this.preset.value === 'file' ? 'Choose a file to animate.' : 'Enter a payload to animate.';
      this.playButton.textContent = 'Play';
      return;
    }

    const urType = this.typeInput.value.trim() || 'bytes';
    const fps = Number(this.fps.value);

    try {
      const frame = this.animator.load({
        payload,
        urType,
        maxFragmentLength: Number(this.frag.value),
        fps,
      });
      this.animator.start();
      this.playing = true;
      this.playButton.textContent = 'Pause';

      const parts = frame.partCount;
      this.meta.textContent = [
        `${payload.length} B payload`,
        `${parts} frame${parts === 1 ? '' : 's'}`,
        `${fps} fps`,
      ].join(' · ');
    } catch (error) {
      this.animator.stop();
      this.playButton.textContent = 'Play';
      this.meta.textContent = '';
      this.frameLabel.textContent = 'error';
      this.error.textContent = error instanceof Error ? error.message : 'Could not render the payload.';
      this.error.hidden = false;
    }
  }

  private togglePlay(): void {
    if (!this.payload) return;
    if (this.playing) {
      this.animator.stop();
      this.playing = false;
      this.playButton.textContent = 'Play';
    } else {
      this.animator.start();
      this.playing = true;
      this.playButton.textContent = 'Pause';
    }
  }

  private showFrame(frame: AnimatorFrame): void {
    this.frameLabel.textContent = frame.singlePart
      ? 'single frame'
      : `frame ${((frame.frame - 1) % frame.partCount) + 1} / ${frame.partCount}`;
  }
}
