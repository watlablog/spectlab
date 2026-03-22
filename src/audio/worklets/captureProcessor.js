const WINDOW_SECONDS = 10
const CHUNK_SIZE = 1024

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.windowSamples = Math.max(1, Math.round(sampleRate * WINDOW_SECONDS))
    this.ring = new Float32Array(this.windowSamples)
    this.ringHead = 0
    this.capturedSamplesNative = 0
    this.chunkBuffer = new Float32Array(CHUNK_SIZE)
    this.chunkLength = 0

    this.port.onmessage = (event) => {
      const data = event?.data
      if (!data || typeof data !== 'object') {
        return
      }

      if (data.type === 'snapshot-request' && typeof data.requestId === 'number') {
        this.handleSnapshotRequest(data.requestId)
      }
    }
  }

  handleSnapshotRequest(requestId) {
    const ordered = new Float32Array(this.windowSamples)
    const firstChunkLength = this.windowSamples - this.ringHead
    ordered.set(this.ring.subarray(this.ringHead), 0)
    if (this.ringHead > 0) {
      ordered.set(this.ring.subarray(0, this.ringHead), firstChunkLength)
    }

    this.port.postMessage(
      {
        type: 'snapshot-response',
        requestId,
        sampleRateHz: sampleRate,
        capturedSamplesNative: this.capturedSamplesNative,
        samples: ordered,
      },
      [ordered.buffer],
    )
  }

  flushChunk() {
    if (this.chunkLength <= 0) {
      return
    }

    const chunk = this.chunkBuffer.slice(0, this.chunkLength)
    this.port.postMessage(
      {
        type: 'capture-chunk',
        nativeSampleRateHz: sampleRate,
        capturedSamplesNative: this.capturedSamplesNative,
        samples: chunk,
      },
      [chunk.buffer],
    )
    this.chunkLength = 0
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    const inputChannel = input?.[0]

    if (!inputChannel) {
      this.flushChunk()
      return true
    }

    for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
      const outChannel = output[channelIndex]
      if (!outChannel) {
        continue
      }
      const inChannel = input[channelIndex] ?? inputChannel
      outChannel.set(inChannel)
    }

    for (let index = 0; index < inputChannel.length; index += 1) {
      const sample = inputChannel[index] ?? 0
      this.ring[this.ringHead] = sample
      this.ringHead = (this.ringHead + 1) % this.windowSamples
      this.capturedSamplesNative += 1

      this.chunkBuffer[this.chunkLength] = sample
      this.chunkLength += 1
      if (this.chunkLength >= CHUNK_SIZE) {
        this.flushChunk()
      }
    }

    return true
  }
}

registerProcessor('capture-processor', CaptureProcessor)
