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
  Contains microphone capture, audio engine control, STFT analysis, file analysis, workers, and worklets.
- `src/render/`
  Draws the spectrogram and FFT visuals.
- `src/ui/`
  Maps DOM elements and updates UI control state.

## State Model

The application state tracks:

- analysis source: live microphone or loaded file
- recording / playback / save / file-loading progress
- microphone readiness and active sample rate
- FFT analysis settings
- visible time / frequency / amplitude ranges
- current error message

No authentication or remote session state exists in the current design.

## Static Deployment

- `vite build` generates the deployable output in `dist/`.
- [public/.htaccess](./public/.htaccess) is copied into `dist/` so Apache-based static hosting can rewrite SPA routes to `index.html`.
- Production hosting must support HTTPS for microphone access.

Sakura-specific deployment notes live in [DEPLOY.md](./DEPLOY.md).
