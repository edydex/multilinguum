class MultilinguumPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(960);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let sourceOffset = 0;
    while (sourceOffset < input.length) {
      const count = Math.min(input.length - sourceOffset, this.pending.length - this.offset);
      this.pending.set(input.subarray(sourceOffset, sourceOffset + count), this.offset);
      sourceOffset += count;
      this.offset += count;
      if (this.offset === this.pending.length) {
        const pcm = new Int16Array(this.pending.length);
        for (let index = 0; index < this.pending.length; index += 1) {
          const sample = Math.max(-1, Math.min(1, this.pending[index]));
          pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('multilinguum-pcm', MultilinguumPcmProcessor);
