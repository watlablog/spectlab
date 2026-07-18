# SpectLab

Live app: https://spectlab-watlab.com/recording

SpectLab is a Vite + TypeScript static web app for recording microphone audio, rendering a realtime spectrogram, inspecting FFT profiles, and loading local audio files for offline analysis. Audio processing runs entirely in the browser.

The main public route is `/recording`. When the app is opened from `/` or `/login`, it normalizes the URL to `/recording`.

## Development

```bash
npm install
npm run dev
npm run test
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
- Switch the spectrogram colormap from the dB color bar.
- Inspect a single-frame FFT or an averaged FFT over a selected time range.
- View the time-domain waveform for the same visible range as the spectrogram.
- Normalize all retained audio non-destructively from the peak in the visible time range.
- Apply a non-destructive Lowpass, Highpass, Bandpass, or Bandstop filter to retained audio.

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

### 6. Detail Tabs

- `Time waveform` and `FFT Profile` share the lower detail area. FFT Profile is selected initially, and the selected tab remains selected when data is cleared or the source changes.
- The spectrogram remains visible because it defines the time/frequency range and FFT cursor.
- The `FFT Profile` tab shows the frequency spectrum for the current spectrogram position or selected range.
- In single mode, click or drag on the spectrogram to move the FFT cursor.
- Click `Average FFT` to switch to average mode.
- In average mode, drag the time selection on the spectrogram to average the FFT over that range.
- Click the `Average FFT` button again to return to single mode.
- The FFT plot updates as you move the spectrogram cursor or change the visible range.

- The `Time waveform` tab shows mono PCM amplitude over the currently visible time range.
- Its time axis always matches `Time.Min` and `Time.Max` on the spectrogram.
- Its amplitude axis is centered on zero and automatically expands or contracts to fit the visible samples.
- Its time cursor is shared with the spectrogram. Dragging the single cursor or either Average FFT range edge in one plot immediately updates the other.
- Spectrogram, FFT, and waveform plot labels use a larger Times New Roman-style serif font for readability.

### 7. Signal Processing

- Signal Processing stays visible beside the detail tabs on desktop. Below 960 px it appears before the tabs.
- Click `Norm.Amp` to calculate `gain = 1 / visible peak` from the filtered, pre-gain PCM. Clicking it again replaces the gain using the new visible range; gains are never accumulated.
- The gain remains active when the time range changes and affects the waveform, spectrogram, FFT, playback, and saved WAV consistently.
- After normalization, the waveform uses at least a `-1` to `+1` amplitude axis. If another range exceeds that level, the axis expands without hiding the peak and the panel shows a clipping warning.
- Float PCM and analysis values are kept above `±1` when necessary. Playback and 16-bit WAV export hard-clip only at their output boundaries.
- `Clear`, loading another file, or starting a new recording resets the gain to `1`.
- Choose `Lowpass`, `Highpass`, `Bandpass`, or `Bandstop`, set cutoff values with the linked numeric controls or logarithmic sliders, then click `Apply`.
- Lowpass and Highpass use a 2nd-order Butterworth response. Bandpass and Bandstop derive their center frequency and Q from the selected Low/High edges.
- Every Apply appends a new filter after the filters already in effect. For example, applying Lowpass and then Highpass keeps both stages active in that order.
- `Remove Filter` removes only the most recently applied stage. Applying another filter commits every earlier stage to the effective output, so after one removal those baked stages remain and cannot be removed individually.
- Filtering is available only while stopped. It processes the entire loaded file or the retained live 10-second window, not only the visible range.
- Filter controls are drafts until `Apply`. Changing the selected type or cutoff values does not alter the active filter until Apply is clicked.
- The fixed processing order is `Original PCM → Filter 1 → Filter 2 → … → Norm gain → playback/WAV clip`. Applying or removing a filter preserves the current Norm gain; pressing `Norm.Amp` recalculates it from the current stacked output.
- Clear, a new file load, and a new recording remove the entire filter stack, including baked stages. Draft cutoff values remain available and are clamped when the sample rate changes.

### 8. Typical Workflow

- Press `Record` and capture audio.
- Narrow the visible area with `Time.Min`, `Time.Max`, `Freq.Min`, and `Freq.Max`.
- Use `Play` to audition the selected range.
- Use `Save Audio` to export the selected range.
- Use the detail tabs to inspect either FFT content or waveform shape for the spectrogram selection.
- Use Signal Processing to filter or normalize the retained signal while comparing the result in either detail tab.
- Use `Load Audio` when you want to analyze an existing local recording instead of live input.
