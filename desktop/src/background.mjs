export class Background {
  constructor(onFrame, onError) {
    this.onFrame = onFrame;
    this.onError = onError;
  }

  async load(file) {
    this.clear();
    const asset = {};
    this.asset = asset;
    try {
      if (file.size > 80 * 1024 * 1024) throw new Error('Максимальный размер фона — 80 МБ');
      if (file.type === 'image/gif' && typeof ImageDecoder === 'function') {
        asset.decoder = new ImageDecoder({ type: file.type, data: file.stream(), preferAnimation: true });
        await asset.decoder.tracks.ready;
        if (this.asset !== asset) return;
        await this.gifFrame(asset, 0);
      } else if (['video/mp4', 'video/webm'].includes(file.type)) {
        asset.url = URL.createObjectURL(file);
        const video = document.createElement('video');
        asset.video = video;
        video.muted = true;
        video.loop = true;
        video.src = asset.url;
        const step = () => {
          if (asset !== this.asset) return;
          this.onFrame(video, video.videoWidth, video.videoHeight);
          video.requestVideoFrameCallback(step);
        };
        await video.play();
        if (this.asset === asset) video.requestVideoFrameCallback(step);
      } else if (['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'].includes(file.type)) {
        const bitmap = await createImageBitmap(file);
        try {
          if (this.asset === asset) this.onFrame(bitmap, bitmap.width, bitmap.height);
        } finally { bitmap.close(); }
      } else {
        throw new Error('Поддерживаются PNG, JPEG, WebP, GIF, AVIF, BMP, MP4 и WebM');
      }
    } catch (error) {
      if (this.asset === asset) {
        this.clear();
        throw error;
      }
    }
  }

  async gifFrame(asset, index) {
    if (this.asset !== asset) return;
    try {
      const { image } = await asset.decoder.decode({ frameIndex: index });
      let delay;
      try {
        if (this.asset !== asset) return;
        this.onFrame(image, image.displayWidth, image.displayHeight);
        delay = Math.max(30, (image.duration || 100000) / 1000);
      } finally { image.close(); }
      if (asset.decoder.tracks.selectedTrack.frameCount > 1) {
        asset.timer = setTimeout(() => {
          this.gifFrame(asset, (index + 1) % asset.decoder.tracks.selectedTrack.frameCount);
        }, delay);
      }
    } catch (error) {
      if (this.asset === asset) {
        this.clear();
        this.onError(error.message);
      }
    }
  }

  clear() {
    const asset = this.asset;
    this.asset = null;
    if (!asset) return;
    clearTimeout(asset.timer);
    asset.decoder?.close();
    asset.video?.pause();
    if (asset.url) URL.revokeObjectURL(asset.url);
  }
}
