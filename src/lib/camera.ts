export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface ZoomRange {
  min: number;
  max: number;
  step: number;
}

export interface CameraCapabilities {
  torch: boolean;
  zoom: ZoomRange | null;
}

/** Subset of the (non-standard) media track capabilities we actually use. */
interface ExtendedCapabilities {
  torch?: boolean;
  zoom?: { min?: number; max?: number; step?: number };
  focusMode?: string[];
}

export class CameraError extends Error {}

function explain(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow camera access in your browser settings and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No usable camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is already in use by another application.';
    default:
      return error instanceof Error ? error.message : 'Could not start the camera.';
  }
}

/** Owns the MediaStream lifecycle for the preview element. */
export class Camera {
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;

  capabilities: CameraCapabilities = { torch: false, zoom: null };

  get isActive(): boolean {
    return this.stream !== null;
  }

  static async listDevices(): Promise<CameraDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((device) => device.kind === 'videoinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        }));
    } catch {
      return [];
    }
  }

  async start(video: HTMLVideoElement, deviceId?: string): Promise<void> {
    this.stop();

    if (!window.isSecureContext) {
      throw new CameraError('Camera access requires HTTPS or localhost.');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('This browser does not expose a camera API.');
    }

    let stream: MediaStream;
    try {
      stream = await this.request(deviceId);
    } catch (error) {
      if (!deviceId) throw new CameraError(explain(error));
      // The previously selected device may have been unplugged.
      try {
        stream = await this.request(undefined);
      } catch (retryError) {
        throw new CameraError(explain(retryError));
      }
    }

    this.stream = stream;
    this.track = stream.getVideoTracks()[0] ?? null;
    this.capabilities = this.readCapabilities();

    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // Autoplay can be blocked; the decode loop waits for readyState anyway.
    }

    await this.optimiseForScanning();
  }

  stop(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.track = null;
    this.capabilities = { torch: false, zoom: null };
  }

  detach(video: HTMLVideoElement): void {
    this.stop();
    video.srcObject = null;
  }

  async setTorch(on: boolean): Promise<boolean> {
    if (!this.track || !this.capabilities.torch) return false;
    try {
      await this.track.applyConstraints({
        advanced: [{ torch: on } as unknown as MediaTrackConstraintSet],
      });
      return true;
    } catch {
      return false;
    }
  }

  async setZoom(value: number): Promise<void> {
    if (!this.track || !this.capabilities.zoom) return;
    try {
      await this.track.applyConstraints({
        advanced: [{ zoom: value } as unknown as MediaTrackConstraintSet],
      });
    } catch {
      // Zoom is best-effort; some drivers advertise but reject the value.
    }
  }

  private request(deviceId?: string): Promise<MediaStream> {
    const video: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = { ideal: 'environment' };

    return navigator.mediaDevices.getUserMedia({ audio: false, video });
  }

  private readCapabilities(): CameraCapabilities {
    const track = this.track;
    if (!track?.getCapabilities) return { torch: false, zoom: null };

    const caps = track.getCapabilities() as unknown as ExtendedCapabilities;
    const zoom = caps.zoom;
    const hasZoom =
      typeof zoom?.min === 'number' && typeof zoom.max === 'number' && zoom.max > zoom.min;

    return {
      torch: caps.torch === true,
      zoom: hasZoom
        ? { min: zoom.min!, max: zoom.max!, step: zoom.step && zoom.step > 0 ? zoom.step : 0.1 }
        : null,
    };
  }

  /** Continuous autofocus dramatically improves dense animated QR reads. */
  private async optimiseForScanning(): Promise<void> {
    const track = this.track;
    if (!track?.getCapabilities) return;
    const caps = track.getCapabilities() as unknown as ExtendedCapabilities;
    if (!caps.focusMode?.includes('continuous')) return;
    try {
      await track.applyConstraints({
        advanced: [{ focusMode: 'continuous' } as unknown as MediaTrackConstraintSet],
      });
    } catch {
      // Not supported by this driver.
    }
  }
}
