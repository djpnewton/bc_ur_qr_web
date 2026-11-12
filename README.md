# UR Scanner

A web app for reading **animated, multi-part [Uniform Resource (UR)](https://github.com/BlockchainCommons/Research/blob/master/papers/bcr-2020-005-ur.md) QR codes** — the format air-gapped Bitcoin wallets use to hand seeds, PSBTs and key descriptors to a networked device.

Everything happens in the browser tab. No payload is uploaded, logged, or sent anywhere.

## Features

- **Live camera scanning** with a reticle/scan-line overlay, torch and zoom where the device supports it.
- **Camera picker** — choose rear/front or a specific device; the choice is remembered, and switching mid-scan keeps the partially decoded UR session.
- **Fountain-code reassembly** via [`@ngraveio/bc-ur`](https://github.com/ngrave-io/bc-ur): frames may arrive out of order, repeat, or be missed.
- **Progress UI** — UR type, recovered/total fragments, and completion estimate while scanning.
- **Image import** — drop in a screenshot of a single frame (repeat for more frames) instead of using a camera.
- **Payload inspector** with tabs for a friendly field summary, CBOR diagnostic notation, JSON, hex, and the re-encoded single-part UR.
- **Save/copy** the decoded bytes or the current view.
- **Built-in test generator** — fountain-encodes any payload and animates it on screen, so you can verify decoding end to end without a second device.
- **Installable PWA** that works offline.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Cameras require a secure context, so use `localhost` or HTTPS. Image import works anywhere.

## Build & deploy

```bash
npm run build      # type-check + bundle into dist/
npm run preview    # serve dist/ locally
```

`dist/` is a static bundle with a relative base path, so it can be hosted from any subdirectory (GitHub Pages, Netlify, an S3 bucket, …).

PWA icons are generated from code:

```bash
npm run icons
```

## How it works

| Concern | Implementation |
| --- | --- |
| QR decoding | `BarcodeDetector` when the platform provides it, otherwise ZXing (`@zxing/browser`). Both are driven from one frame loop at ~14–25 fps. |
| UR reassembly | `URDecoder` from `@ngraveio/bc-ur`, wrapped in `src/lib/ur-session.ts` for duplicate detection, type tracking and timing. |
| Payload inspection | `src/lib/cbor.ts` walks cborg's tokenizer directly, so numeric map keys, byte strings and tags survive — which `cborg.decode()` would otherwise reject or flatten. |
| Test generator | `UREncoder` → ZXing `QRCodeWriter` → canvas, frame-cached by part string. |

A large payload is split into fragments, each rendered as a `ur:<type>/<seq>/<bytewords>` frame. The decoder is done as soon as the fountain code and the bytewords checksum agree, which typically needs *n* frames for an *n*-fragment message plus a small overhead.

## Project structure

```
index.html                 markup and dialogs
src/main.ts                app controller: camera, scan loop, result state
src/lib/qr-decoder.ts      BarcodeDetector / ZXing frame decoding
src/lib/qr-generator.ts    fountain encoding → animated QR canvas
src/lib/ur-session.ts      UR decode session + progress bookkeeping
src/lib/cbor.ts            CBOR tree, diagnostic notation, field labels
src/ui/                    result view, generator dialog, toasts
scripts/gen-icons.mjs      PWA icon generation
```

## Notes

- Payloads from hardware wallets are usually **secret material**. Treat anything decoded here accordingly.
- `ur:bytes` and `crypto-psbt` payloads are CBOR-encoded as required by the spec; the inspector parses them the same way as every other type.
- Browser support: any modern Chromium, Firefox or Safari. Native `BarcodeDetector` improves frame rate on Android/Chrome but is not required.
