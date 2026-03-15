class UpperFrequencyProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'cutoffHz',
        defaultValue: 20000,
        minValue: 100,
        maxValue: 24000,
        automationRate: 'k-rate',
      },
    ]
  }

  constructor() {
    super()
    this.previousByChannel = []
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]

    if (!output || output.length === 0) {
      return true
    }

    const cutoffParam = parameters.cutoffHz
    const cutoffHz = cutoffParam.length > 0 ? cutoffParam[0] : 20000
    const normalizedCutoffHz = Math.max(20, Math.min(cutoffHz, sampleRate * 0.5))
    const omega = 2 * Math.PI * normalizedCutoffHz
    const dt = 1 / sampleRate
    const alpha = (omega * dt) / (1 + omega * dt)

    for (let channel = 0; channel < output.length; channel += 1) {
      const inChannel = input?.[channel]
      const outChannel = output[channel]

      if (!outChannel) {
        continue
      }

      let previous = this.previousByChannel[channel] ?? 0

      if (!inChannel) {
        outChannel.fill(previous)
        this.previousByChannel[channel] = previous
        continue
      }

      for (let index = 0; index < outChannel.length; index += 1) {
        previous += alpha * (inChannel[index] - previous)
        outChannel[index] = previous
      }

      this.previousByChannel[channel] = previous
    }

    return true
  }
}

registerProcessor('upper-frequency-processor', UpperFrequencyProcessor)
