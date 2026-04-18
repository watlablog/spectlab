# SpectLab v1.0.0

Live app: https://spectlab-watlab.com/recording

SpectLab is a Vite + TypeScript static web app for recording microphone audio, rendering a realtime spectrogram, inspecting FFT profiles, and loading local audio files for offline analysis. Audio processing runs entirely in the browser.

The main public route is `/recording`. When the app is opened from `/` or `/login`, it normalizes the URL to `/recording`.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

The production build outputs static files to `dist/`.

## Static Deployment

- Upload the contents of `dist/` to a static host.
- Keep the generated `.htaccess` file next to `index.html` when deploying to Apache-based hosting such as Sakura Rental Server.
- Configure SPA fallback so direct access to `/recording` serves `index.html`.
- Use HTTPS in production because browser microphone access requires a secure context.

Sakura-specific deployment notes are in [DEPLOY.md](./DEPLOY.md).

## What SpectLab Can Do

- Capture microphone audio and draw a scrolling spectrogram in realtime.
- Load local audio files for offline inspection.
- Play back the currently visible time range.
- Save the currently visible time range as a WAV file.
- Adjust visible frequency, amplitude, and time ranges with both numeric inputs and sliders.
- Inspect a single-frame FFT or an averaged FFT over a selected time range.

## How to Use SpectLab

### 1. Start Recording

- Open the app over HTTPS.
- Click `Record`.
- Allow microphone access when the browser asks for permission.
- The spectrogram starts updating in realtime.
- Click `Stop` on the same button to end live capture.

### 2. Main Action Buttons

- `Record` / `Stop`
  Starts or stops live microphone analysis.
- `Clear`
  Removes the current captured or loaded data and resets the view back to the default live range.
- `Save Audio`
  Exports the currently visible time range as a local WAV file.
- `Load Audio`
  Opens a local audio file and switches the app into File mode.
- `Play` / `Stop`
  Plays only the currently visible time range.

### 3. Analysis Settings

- `Frame size`
  Sets the FFT frame size. Larger values improve frequency resolution but reduce time resolution.
- `Overlap [%]`
  Sets how much adjacent analysis windows overlap. Press `Enter` after typing a value.
- `Upper [Hz]`
  Sets the analysis ceiling for the spectrogram and FFT display.

These settings are locked while recording, playing back, or loading a file.

### 4. Range Controls

- `Freq.Min` and `Freq.Max`
  Control the visible frequency range.
- `Amp.Min` and `Amp.Max`
  Control the displayed dB color range.
- `Time.Min` and `Time.Max`
  Control the visible time window used for playback, saving, and FFT inspection.

You can either type values directly or drag the corresponding sliders. Typed values are applied when you press `Enter`.

### 5. File Mode

- Use `Load Audio` to inspect a local file instead of the live microphone stream.
- The app accepts common browser-supported audio formats.
- Files larger than 100 MB are rejected.
- Files longer than 30 minutes are rejected.
- In File mode, the time range expands to the loaded file length instead of the default 10-second live window.
- Press `Record` to leave File mode and return to live capture mode.

### 6. FFT Profile

- The `FFT Profile` panel shows the frequency spectrum for the current spectrogram position or selected range.
- In single mode, click or drag on the spectrogram to move the FFT cursor.
- Click `Average FFT` to switch to average mode.
- In average mode, drag the time selection on the spectrogram to average the FFT over that range.
- Click the `Average FFT` button again to return to single mode.
- The FFT plot updates as you move the spectrogram cursor or change the visible range.

### 7. Typical Workflow

- Press `Record` and capture audio.
- Narrow the visible area with `Time.Min`, `Time.Max`, `Freq.Min`, and `Freq.Max`.
- Use `Play` to audition the selected range.
- Use `Save Audio` to export the selected range.
- Use the `FFT Profile` panel to inspect spectral content at a point or across a short segment.
- Use `Load Audio` when you want to analyze an existing local recording instead of live input.
