class MultilinguumPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(960);
    this.offset = 0;
  }

  process(inputs) {
    const channels = inputs[0] ?? [];
    if (channels.length === 0) return true;
    let activeChannel = 0;
    let activeEnergy = -1;
    for (let channel = 0; channel < channels.length; channel += 1) {
      let energy = 0;
      for (const sample of channels[channel]) energy += sample * sample;
      if (energy > activeEnergy) {
        activeEnergy = energy;
        activeChannel = channel;
      }
    }
    const input = channels[activeChannel];
    let sourceOffset = 0;
    while (sourceOffset < input.length) {
      const count = Math.min(input.length - sourceOffset, this.pending.length - this.offset);
      this.pending.set(input.subarray(sourceOffset, sourceOffset + count), this.offset);
      sourceOffset += count;
      this.offset += count;
      if (this.offset === this.pending.length) {
        const pcm = new Int16Array(this.pending.length);
        let energy = 0;
        let peak = 0;
        for (let index = 0; index < this.pending.length; index += 1) {
          const sample = Math.max(-1, Math.min(1, this.pending[index]));
          energy += sample * sample;
          peak = Math.max(peak, Math.abs(sample));
          pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        this.port.postMessage(
          {
            pcm: pcm.buffer,
            rms: Math.sqrt(energy / this.pending.length),
            peak,
            channel: activeChannel,
            channelCount: channels.length,
          },
          [pcm.buffer],
        );
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('multilinguum-pcm', MultilinguumPcmProcessor);
