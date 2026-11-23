export class Monitor {
  constructor(onLevel) {
    this.onLevel = onLevel;
    this.active = false;
    this.delay = 0;
  }

  async enable(sinkId, volume) {
    await this.disable();
    const context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000, sinkId });
    this.context = context;
    this.gain = context.createGain();
    this.gain.gain.value = volume;
    this.gain.connect(context.destination);
    this.delayNode = context.createDelay(0.5);
    this.delayNode.delayTime.value = this.delay;
    this.delayNode.connect(this.gain);
    this.nextStart = 0;
    try {
      await context.resume();
    } catch (error) {
      await this.disable();
      throw error;
    }
  }

  async setSinkId(sinkId) {
    if (this.context) await this.context.setSinkId(sinkId);
  }

  setVolume(volume) {
    if (this.gain) this.gain.gain.setTargetAtTime(volume, this.context.currentTime, 0.02);
  }

  push(bytes) {
    if (!this.active || !this.context) return;
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sampleCount = data.byteLength / 2;
    const audio = this.context.createBuffer(1, sampleCount, 48000);
    const samples = audio.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = data.getInt16(i * 2, true) / 32768;
      peak = Math.max(peak, Math.abs(samples[i]));
    }
    this.onLevel(peak);
    const clock = this.context.currentTime;
    if (this.nextStart < clock) this.nextStart = clock + 0.035;
    if (this.nextStart - clock > 0.13) return;
    const source = this.context.createBufferSource();
    source.buffer = audio;
    source.connect(this.delayNode);
    source.start(this.nextStart);
    this.nextStart += audio.duration;
  }

  setDelay(seconds) {
    this.delay = seconds;
    if (this.delayNode) this.delayNode.delayTime.setTargetAtTime(seconds, this.context.currentTime, 0.04);
  }

  async disable() {
    const context = this.context;
    this.context = null;
    this.gain = null;
    this.delayNode = null;
    if (context && context.state !== 'closed') await context.close();
    this.onLevel(0);
  }
}
