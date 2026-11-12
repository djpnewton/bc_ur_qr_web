import './polyfills';
import './styles.css';

import { Camera, CameraError, type CameraStartOptions } from './lib/camera';
import { asPrintableText, parseCbor, type CborNode } from './lib/cbor';
import { QrDecoder } from './lib/qr-decoder';
import { UrSession, type UrProgress, type UrResult } from './lib/ur-session';
import { must } from './ui/dom';
import { GeneratorDialog } from './ui/generator-dialog';
import { ResultView } from './ui/result-view';
import { toast } from './ui/toast';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type ViewState = 'idle' | 'scanning' | 'decoding' | 'done' | 'error';

const ENGINE_LABELS: Record<string, string> = {
  native: 'BarcodeDetector',
  zxing: 'ZXing',
};

const CAMERA_PREF_KEY = 'ur-scanner:camera';
/** Select values that are not device ids. */
const PREF_AUTO = '';
const PREF_FRONT = 'user';

function readStoredCamera(): string {
  try {
    return localStorage.getItem(CAMERA_PREF_KEY) ?? PREF_AUTO;
  } catch {
    return PREF_AUTO;
  }
}

function storeCamera(value: string): void {
  try {
    localStorage.setItem(CAMERA_PREF_KEY, value);
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts one session.
  }
}

function toStartOptions(preference: string): CameraStartOptions {
  if (preference === PREF_FRONT) return { facingMode: 'user' };
  if (preference === PREF_AUTO) return { facingMode: 'environment' };
  return { deviceId: preference };
}

function textFromNode(node: CborNode): string | null {
  if (node.kind === 'text') return node.value;
  if (node.kind === 'bytes') return asPrintableText(node.value);
  return null;
}

class ScannerApp {
  private readonly video = must<HTMLVideoElement>('video');
  private readonly preview = must<HTMLImageElement>('preview');
  private readonly viewport = must<HTMLElement>('viewport');
  private readonly hud = must<HTMLElement>('hud');
  private readonly hudType = must<HTMLElement>('hud-type');
  private readonly hudPercent = must<HTMLElement>('hud-percent');
  private readonly hudBar = must<HTMLElement>('hud-bar');
  private readonly hudParts = must<HTMLElement>('hud-parts');
  private readonly hudRate = must<HTMLElement>('hud-rate');
  private readonly statusPill = must<HTMLElement>('status-pill');
  private readonly statusText = must<HTMLElement>('status-text');
  private readonly startButton = must<HTMLButtonElement>('start-btn');
  private readonly importButton = must<HTMLButtonElement>('import-btn');
  private readonly resetButton = must<HTMLButtonElement>('reset-btn');
  private readonly generatorButton = must<HTMLButtonElement>('generator-btn');
  private readonly fileInput = must<HTMLInputElement>('file-input');
  private readonly cameraField = must<HTMLElement>('camera-field');
  private readonly cameraSelect = must<HTMLSelectElement>('camera-select');
  private readonly cameraNote = must<HTMLElement>('camera-note');
  private readonly torchField = must<HTMLElement>('torch-field');
  private readonly torchButton = must<HTMLButtonElement>('torch-btn');
  private readonly zoomField = must<HTMLElement>('zoom-field');
  private readonly zoomRange = must<HTMLInputElement>('zoom-range');
  private readonly cameraHint = must<HTMLElement>('camera-hint');
  private readonly engineName = must<HTMLElement>('engine-name');
  private readonly installButton = must<HTMLButtonElement>('install-btn');
  private readonly helpButton = must<HTMLButtonElement>('help-btn');
  private readonly helpDialog = must<HTMLDialogElement>('help-dialog');

  private readonly session = new UrSession();
  private readonly camera = new Camera();
  private readonly resultView: ResultView;
  private readonly generator: GeneratorDialog;

  private decoder: QrDecoder | null = null;
  private running = false;
  private frameTimer = 0;
  private frameInterval = 70;
  private flashTimer = 0;
  private lastNotUrAt = -Infinity;
  private lastOtherTypeAt = -Infinity;
  private lastFrameErrorAt = -Infinity;
  private previewUrl: string | null = null;
  private installEvent: BeforeInstallPromptEvent | null = null;
  private cameraPreference = readStoredCamera();

  constructor() {
    this.resultView = new ResultView(
      must<HTMLElement>('result-body'),
      must<HTMLElement>('result-type'),
      () => this.reset(),
    );
    this.generator = new GeneratorDialog();
    this.wireEvents();
  }

  async init(): Promise<void> {
    this.setStatus('Starting…', 'idle');

    try {
      this.decoder = await QrDecoder.create();
      this.engineName.textContent = ENGINE_LABELS[this.decoder.engine] ?? this.decoder.engine;
    } catch (error) {
      this.engineName.textContent = 'unavailable';
      this.setStatus('Decoder unavailable', 'error');
      this.showHint(error instanceof Error ? error.message : 'Could not initialise the QR decoder.');
      return;
    }

    this.setStatus('Camera off', 'idle');
    if (!window.isSecureContext) {
      this.showHint('Camera access needs HTTPS or localhost. Importing screenshots still works.');
    }

    await this.refreshCameras();
    navigator.mediaDevices?.addEventListener?.('devicechange', () => void this.refreshCameras());
  }

  private wireEvents(): void {
    this.startButton.addEventListener('click', () => {
      if (this.camera.isActive) this.stopCamera();
      else void this.startCamera();
    });

    this.importButton.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) void this.importImage(file);
    });

    this.resetButton.addEventListener('click', () => this.reset());
    this.generatorButton.addEventListener('click', () => this.generator.open());

    this.cameraSelect.addEventListener('change', () => {
      this.cameraPreference = this.cameraSelect.value;
      storeCamera(this.cameraPreference);
      // Switching while scanning keeps the partially decoded UR session intact.
      if (this.camera.isActive) void this.startCamera();
    });

    this.torchButton.addEventListener('click', async () => {
      const next = this.torchButton.getAttribute('aria-pressed') !== 'true';
      const applied = await this.camera.setTorch(next);
      this.torchButton.setAttribute('aria-pressed', String(applied && next));
      this.torchButton.textContent = applied && next ? 'On' : 'Off';
      if (!applied) toast('This camera does not expose a torch', 'warn');
    });

    this.zoomRange.addEventListener('input', () => {
      void this.camera.setZoom(Number(this.zoomRange.value));
    });

    this.helpButton.addEventListener('click', () => {
      if (!this.helpDialog.open) this.helpDialog.showModal();
    });

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.installEvent = event as BeforeInstallPromptEvent;
      this.installButton.hidden = false;
    });

    this.installButton.addEventListener('click', async () => {
      const prompt = this.installEvent;
      if (!prompt) return;
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted') this.installButton.hidden = true;
      this.installEvent = null;
    });

    window.addEventListener('appinstalled', () => {
      this.installButton.hidden = true;
    });

    window.addEventListener('pagehide', () => this.camera.stop());
  }

  /* ------------------------------------------------------------- camera */

  private async startCamera(override?: string): Promise<void> {
    this.clearPreview();
    this.setStatus('Starting…', 'idle');
    this.cameraHint.hidden = true;

    const preference = override ?? (this.cameraSelect.value || this.cameraPreference);
    try {
      await this.camera.start(this.video, toStartOptions(preference));
    } catch (error) {
      this.stopLoop();
      this.startButton.textContent = 'Start camera';
      this.setStatus('Camera error', 'error');
      this.showHint(
        error instanceof CameraError
          ? error.message
          : 'Could not start the camera. Check permissions and try again.',
      );
      return;
    }

    this.viewport.classList.add('live');
    this.startButton.textContent = 'Stop camera';
    this.applyCapabilities();
    await this.refreshCameras();

    if (this.session.isComplete) {
      this.setStatus('Decoded', 'done');
      return;
    }

    this.viewport.dataset.state = 'scanning';
    this.setStatus('Scanning', 'scanning');
    this.startLoop();
  }

  private stopCamera(): void {
    this.stopLoop();
    this.camera.detach(this.video);
    // Keep the overlay + progress HUD visible when a decode is still in flight.
    const keepLive = !this.session.isComplete && !this.hud.hidden;
    this.viewport.classList.toggle('live', keepLive);
    if (this.session.isComplete) {
      this.viewport.dataset.state = 'done';
    } else {
      this.viewport.dataset.state = 'idle';
    }
    this.startButton.textContent = 'Start camera';
    this.setStatus('Camera off', 'idle');
    this.torchField.hidden = true;
    this.zoomField.hidden = true;
    this.torchButton.setAttribute('aria-pressed', 'false');
    this.torchButton.textContent = 'Off';
  }

  private applyCapabilities(): void {
    const { torch, zoom } = this.camera.capabilities;
    this.torchField.hidden = !torch;
    this.zoomField.hidden = !zoom;

    if (zoom) {
      this.zoomRange.min = String(zoom.min);
      this.zoomRange.max = String(zoom.max);
      this.zoomRange.step = String(zoom.step);
      this.zoomRange.value = String(zoom.min);
    }
  }

  private async refreshCameras(): Promise<void> {
    const devices = await Camera.listDevices();
    const previous = this.cameraPreference;

    const options = document.createDocumentFragment();
    // Facing-mode entries always work, even before permission reveals any ids.
    options.append(new Option('Default camera (rear)', PREF_AUTO), new Option('Front camera', PREF_FRONT));
    for (const device of devices) {
      options.append(new Option(device.label, device.deviceId));
    }
    this.cameraSelect.replaceChildren(options);

    const valid =
      previous === PREF_AUTO || previous === PREF_FRONT
        ? previous
        : devices.some((device) => device.deviceId === previous)
          ? previous
          : PREF_AUTO;

    this.cameraSelect.value = valid;
    if (valid !== previous) {
      this.cameraPreference = valid;
      storeCamera(valid);
    }

    this.cameraField.hidden = !navigator.mediaDevices?.getUserMedia;
    // Hide the note only once every listed camera has a real name.
    this.cameraNote.hidden = devices.length > 0 && devices.every((device) => device.named);
  }

  /* ------------------------------------------------------------- decode loop */

  private startLoop(): void {
    if (this.running || !this.decoder) return;
    this.running = true;
    this.frameInterval = this.decoder.engine === 'native' ? 45 : 70;

    const tick = async (): Promise<void> => {
      if (!this.running || !this.decoder) return;
      const started = performance.now();
      try {
        const text = await this.decoder.decodeVideo(this.video);
        if (text && this.running) this.consume(text);
      } catch {
        // A single bad frame must never kill the loop.
      }
      if (!this.running) return;
      const wait = Math.max(0, this.frameInterval - (performance.now() - started));
      this.frameTimer = window.setTimeout(() => void tick(), wait);
    };

    void tick();
  }

  private stopLoop(): void {
    this.running = false;
    window.clearTimeout(this.frameTimer);
  }

  /* ------------------------------------------------------------- image import */

  private async importImage(file: File): Promise<void> {
    if (!this.decoder) {
      toast('The QR decoder is still initialising', 'warn');
      return;
    }

    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      toast('That image format could not be read', 'error');
      return;
    }

    this.showPreview(file);
    this.viewport.classList.add('live');
    if (!this.camera.isActive && !this.session.isComplete) {
      this.setStatus('Reading image', 'decoding');
    }

    try {
      const text = await this.decoder.decodeImage(bitmap);
      if (!text) {
        toast('No QR code found in that image', 'warn');
        if (!this.camera.isActive) this.setStatus('No code found', 'idle');
        return;
      }
      this.consume(text);
    } finally {
      bitmap.close();
    }
  }

  private showPreview(file: File): void {
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = URL.createObjectURL(file);
    this.preview.src = this.previewUrl;
    this.viewport.classList.add('has-preview');
  }

  private clearPreview(): void {
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
    this.preview.removeAttribute('src');
    this.viewport.classList.remove('has-preview', 'live');
  }

  /* ------------------------------------------------------------- UR handling */

  private consume(text: string): void {
    const attempt = this.session.receive(text);

    switch (attempt.kind) {
      case 'not-ur':
        this.noteNotUr();
        break;
      case 'other-type':
        this.noteOtherType(attempt.type);
        break;
      case 'progress':
        this.updateProgress(attempt.progress, attempt.advanced);
        break;
      case 'complete':
        this.complete(attempt.result);
        break;
      case 'error':
        if (attempt.fatal) {
          this.stopLoop();
          this.setStatus('Decode failed', 'error');
          toast(`${attempt.message} — press Reset to start over.`, 'error', 6000);
        } else {
          this.noteFrameError(attempt.message);
        }
        break;
    }
  }

  private noteNotUr(): void {
    const now = performance.now();
    if (now - this.lastNotUrAt < 5000) return;
    this.lastNotUrAt = now;
    toast('That QR code is not a UR code — looking for one that starts with “ur:”.', 'warn');
    if (!this.camera.isActive) this.setStatus('No UR code in that image', 'idle');
  }

  private noteFrameError(message: string): void {
    const now = performance.now();
    if (now - this.lastFrameErrorAt < 6000) return;
    this.lastFrameErrorAt = now;
    toast(`Skipped a frame — ${message}`, 'warn');
    if (!this.camera.isActive) this.setStatus('Could not read that frame', 'idle');
  }

  private noteOtherType(type: string): void {
    const now = performance.now();
    if (now - this.lastOtherTypeAt < 5000) return;
    this.lastOtherTypeAt = now;
    toast(`Ignoring “${type}” frames while decoding “${this.session.type ?? 'ur'}”.`, 'warn');
  }

  private updateProgress(progress: UrProgress, advanced: boolean): void {
    this.hud.hidden = false;
    this.hudType.textContent = progress.type;

    const percent = Math.round(progress.percent * 100);
    this.hudPercent.textContent = `${percent}%`;
    this.hudBar.style.width = `${Math.min(100, progress.percent * 100)}%`;
    this.hudParts.textContent = progress.expected
      ? `${progress.received} / ${progress.expected} parts`
      : `${progress.received} parts`;
    this.hudRate.textContent = `${progress.accepted} frame${progress.accepted === 1 ? '' : 's'} read`;

    if (!this.session.isComplete) {
      this.setStatus(`Collecting · ${percent}%`, 'decoding');
    }

    if (advanced) this.flashHit();
  }

  private flashHit(): void {
    this.viewport.classList.add('hit');
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => this.viewport.classList.remove('hit'), 220);
  }

  private complete(result: UrResult): void {
    this.stopLoop();
    this.viewport.dataset.state = 'done';
    this.viewport.classList.remove('hit');
    this.setStatus('Decoded', 'done');

    this.hud.hidden = false;
    this.hudType.textContent = result.type;
    this.hudPercent.textContent = '100%';
    this.hudBar.style.width = '100%';
    this.hudParts.textContent = result.singlePart
      ? 'single frame'
      : `${result.accepted} frames merged`;
    this.hudRate.textContent = '';

    const cbor = parseCbor(result.payload);
    const text = cbor.ok ? textFromNode(cbor.node) : null;
    this.resultView.show({ result, cbor, text });

    toast(`Decoded “${result.type}” · ${result.payload.length} bytes`, 'ok');
  }

  private reset(): void {
    this.stopLoop();
    this.session.reset();

    this.hud.hidden = true;
    this.hudBar.style.width = '0%';
    this.hudPercent.textContent = '0%';
    this.hudParts.textContent = '0 / 0 parts';
    this.hudRate.textContent = '';
    this.viewport.classList.remove('hit');
    this.resultView.showEmpty();
    this.lastNotUrAt = -Infinity;
    this.lastOtherTypeAt = -Infinity;
    this.lastFrameErrorAt = -Infinity;

    if (this.camera.isActive) {
      this.viewport.dataset.state = 'scanning';
      this.setStatus('Scanning', 'scanning');
      this.startLoop();
    } else {
      this.clearPreview();
      this.viewport.dataset.state = 'idle';
      this.setStatus('Camera off', 'idle');
    }
  }

  /* ------------------------------------------------------------- chrome */

  private setStatus(text: string, state: ViewState): void {
    this.statusText.textContent = text;
    this.statusPill.dataset.state = state;
  }

  private showHint(message: string): void {
    this.cameraHint.textContent = message;
    this.cameraHint.hidden = false;
  }
}

const app = new ScannerApp();
void app.init();
