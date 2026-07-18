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
- recording / playback / save / file-loading / amplitude-normalization / filter progress
- microphone readiness and active sample rate
- FFT analysis settings
- visible time / frequency / amplitude ranges
- current error message
- non-destructive amplitude-normalization state, total gain, and normalized retained-audio peak
- selected lower detail tab, filter draft, ordered filter stack, and filter generation/progress

No authentication or remote session state exists in the current design.

## Lower Workspace

- The spectrogram remains permanently visible because it owns the shared time/frequency selection and FFT cursor.
- Time waveform and FFT Profile are mutually exclusive ARIA tabs in the lower detail area, with FFT Profile selected initially. Switching tabs resizes and redraws the newly visible canvas; hidden FFT drawing is skipped.
- Signal Processing is separate from display tabs so filter and level controls remain available while either result view is open. Desktop uses detail-left/controls-right; below 960 px the controls precede the detail tabs.
- Spectrogram, FFT, and waveform Canvas axes use DPR-scaled larger Times New Roman-style fonts and margins so labels retain their intended CSS size on high-density displays.
- The waveform and spectrogram share the same single/average time-cursor state. Either Canvas can select and drag the single cursor or nearest average-range edge; pointer capture, live-data clamping, FFT refresh, and both overlays update through one interaction path.

## Time Waveform Data Flow

- The waveform uses the same visible `timeMinSec` and `timeMaxSec` values as the spectrogram and does not add persistent application state.
- Workers reduce PCM samples to one minimum/maximum pair per waveform canvas column, preserving short peaks without transferring full audio ranges to the UI thread.
- Live analysis reads the effective rolling 10-second PCM window and marks not-yet-recorded columns as unavailable.
- File analysis builds a hierarchical min/max index when audio is loaded and builds a replacement index for the complete filter stack when Apply or Remove runs, so long time ranges can be queried without rescanning the entire file.
- The renderer uses a zero-centered, symmetric amplitude range with five percent headroom and redraws at most once every 50 milliseconds during live capture.

## Non-destructive Amplitude Normalization

- `Norm.Amp` requests a one-column waveform envelope for the visible time range and calculates `gain = 1 / max(abs(visible PCM))`. A second one-column request calculates the exact peak for the entire loaded file or the retained live 10-second PCM ring.
- The gain always comes from effective worker-side PCM after the complete filter stack and before gain. Repeated normalization replaces the previous total gain instead of multiplying it, so gain calculations are never cumulative.
- A request sequence plus captured source and time-domain values rejects stale results after range changes, source changes, clears, new loads, or new recordings.
- Waveform min/max values are multiplied on the UI thread. An active normalized waveform uses a minimum symmetric axis of `±1` and expands when the current range contains a larger out-of-range peak.
- Spectrogram and FFT data remain stored in their current pre-gain form (original or filtered). Rendering applies `20 * log10(gain)` while retaining the `-160 dB` silence floor, so changing gain redraws existing history without reanalysis.
- Playback and WAV export read the same effective gain. Internal float PCM may exceed `±1`; samples are hard-clipped only when creating a playback buffer or encoding 16-bit WAV output.
- Normalization is disabled while recording, loading, playing, saving, or already calculating, and for missing or effectively silent (`peak <= 1e-6`) visible ranges. Clear, a new file load, and a new recording reset the gain to `1`.

## Stacked Audio Filtering

- The processing graph is `Original PCM → Filter 1 → Filter 2 → … → Norm gain → playback/WAV clip`. All waveform, STFT, FFT, playback, and save paths read the same effective stacked signal.
- Every Apply appends the current draft as the final cascade stage, including when it matches an earlier filter. At that point every previously active stage becomes baked; only the newly appended final stage is removable.
- Remove Filter pops that one removable final stage and then becomes unavailable. Baked stages remain effective and cannot be removed individually. Clear, a new file load, or a new recording is required to discard them.
- Original PCM and the ordered configurations remain available internally so the baked result can be rebuilt deterministically without destructive source mutation.
- Apply/Remove preserves the Norm gain, while a later Norm.Amp operation recalculates from stacked, pre-gain PCM. Clear, source changes, file loads, and new recordings remove the entire stack.
- `src/audio/filter.ts` implements RBJ coefficients and Direct Form II Transposed processing without Web Audio nodes. Coefficients and state use JavaScript Float64 numbers; PCM input/output uses `Float32Array`.
- Lowpass/Highpass are 2nd-order Butterworth filters (`Q = 1/√2`). Bandpass/Bandstop use `f0 = √(low × high)` and `Q = f0 / (high - low)`. Frequencies are restricted to `1 Hz` through `0.99 × Nyquist`, with `Q <= 100` enforced through minimum bandwidth validation.
- File filtering scans original PCM through every cascade stage asynchronously in 65,536-sample work units. It stores each stage's Direct Form II state every 4,096 samples and a hierarchical filtered min/max index, but not a full filtered copy. Waveform boundaries, STFT frames, playback, and save slices reconstruct only the required interval from the nearest multi-stage checkpoint.
- Live filtering is limited to stopped retained audio. Because the rolling window is at most 10 seconds, the live worker materializes the complete stacked output and rebuilds its waveform/STFT history whenever the stack changes.
- Worker messages carry request and filter generations. Progress is reported to the UI, while Clear, source changes, file loads, and new recordings invalidate stale work and remove the full stack. Draft settings persist for the browser session and are clamped to a new Nyquist.
- Filter and normalization operations are mutually exclusive and disabled during recording, playback, save, or load. No realtime recording filter, partial-range filter, bypass, original overlay, or response plot is provided.

## DSP Tests

- Vitest verifies response levels, finite/stable coefficients, one-shot versus chunked equivalence, ordered cascade application, single-stage pop behavior, exact multi-stage checkpoint restoration, and source PCM immutability.

## Static Deployment

- `vite build` generates the deployable output in `dist/`.
- [public/.htaccess](./public/.htaccess) is copied into `dist/` so Apache-based static hosting can rewrite SPA routes to `index.html`.
- Production hosting must support HTTPS for microphone access.

Sakura-specific deployment notes live in [DEPLOY.md](./DEPLOY.md).
