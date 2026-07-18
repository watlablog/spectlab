# SpectLab Design

## Overview

SpectLab is a static browser application for recording microphone audio, rendering a realtime spectrogram, inspecting FFT profiles, and loading local audio files for offline analysis. The runtime is frontend-only and does not depend on backend services or user authentication.

The supported public route is `/recording`. If the app is loaded from `/` or `/login`, the client normalizes the URL to `/recording`.

## Runtime Structure

- `src/main.ts`
  Bootstraps the application and renders a fatal startup error if initialization fails.
- `src/app/app.ts`
  Owns route normalization, app state orchestration, UI wiring, playback, recording control, range sliders, and FFT interactions.
- `src/app/state.ts`
  Provides the small observable state store used across the app.
- `src/audio/`
  Contains microphone capture, audio engine control, STFT analysis, waveform envelope aggregation, file analysis, workers, and worklets.
- `src/render/`
  Draws the spectrogram, FFT, and time-waveform visuals.
- `src/ui/`
  Maps DOM elements and updates UI control state.

## State Model

The application state tracks:

- analysis source: live microphone or loaded file
- recording / playback / save / file-loading / amplitude-normalization progress
- microphone readiness and active sample rate
- FFT analysis settings
- visible time / frequency / amplitude ranges
- current error message
- non-destructive amplitude-normalization state, total gain, and normalized retained-audio peak

No authentication or remote session state exists in the current design.

## Time Waveform Data Flow

- The waveform uses the same visible `timeMinSec` and `timeMaxSec` values as the spectrogram and does not add persistent application state.
- Workers reduce PCM samples to one minimum/maximum pair per waveform canvas column, preserving short peaks without transferring full audio ranges to the UI thread.
- Live analysis reads the rolling 10-second PCM ring directly and marks not-yet-recorded columns as unavailable.
- File analysis builds a hierarchical min/max index when audio is loaded so long time ranges can be queried without rescanning the entire file.
- The renderer uses a zero-centered, symmetric amplitude range with five percent headroom and redraws at most once every 50 milliseconds during live capture.

## Non-destructive Amplitude Normalization

- `Norm.Amp` requests a one-column waveform envelope for the visible time range and calculates `gain = 1 / max(abs(visible PCM))`. A second one-column request calculates the exact peak for the entire loaded file or the retained live 10-second PCM ring.
- The gain always comes from original worker-side PCM. Repeated normalization replaces the previous total gain instead of multiplying it, so source samples and waveform min/max indexes remain unchanged.
- A request sequence plus captured source and time-domain values rejects stale results after range changes, source changes, clears, new loads, or new recordings.
- Waveform min/max values are multiplied on the UI thread. An active normalized waveform uses a minimum symmetric axis of `±1` and expands when the current range contains a larger out-of-range peak.
- Spectrogram and FFT data remain stored in their original form. Rendering applies `20 * log10(gain)` while retaining the `-160 dB` silence floor, so changing gain redraws existing history without reanalysis.
- Playback and WAV export read the same effective gain. Internal float PCM may exceed `±1`; samples are hard-clipped only when creating a playback buffer or encoding 16-bit WAV output.
- Normalization is disabled while recording, loading, playing, saving, or already calculating, and for missing or effectively silent (`peak <= 1e-6`) visible ranges. Clear, a new file load, and a new recording reset the gain to `1`.

## Static Deployment

- `vite build` generates the deployable output in `dist/`.
- [public/.htaccess](./public/.htaccess) is copied into `dist/` so Apache-based static hosting can rewrite SPA routes to `index.html`.
- Production hosting must support HTTPS for microphone access.

Sakura-specific deployment notes live in [DEPLOY.md](./DEPLOY.md).
