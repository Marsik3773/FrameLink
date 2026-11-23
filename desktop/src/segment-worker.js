/* global FrameLinkVision */
importScripts('../node_modules/@mediapipe/tasks-vision/vision_bundle.cjs');
const base = '../node_modules/@mediapipe/tasks-vision/wasm';
const canvas = new OffscreenCanvas(1, 1);
const context = canvas.getContext('2d', { alpha: false });
let initialization;
let previous;
let previousWidth;
let previousHeight;
let lastTimestamp = -1;

function initialize() {
  if (!initialization) {
    initialization = FrameLinkVision.FilesetResolver.forVisionTasks(base).then(async fileset => {
      const response = await fetch('../assets/selfie_segmenter.tflite');
      if (!response.ok) throw new Error('Модель сегментации отсутствует');
      return FrameLinkVision.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: new Uint8Array(await response.arrayBuffer()), delegate: 'CPU' },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true
      });
    });
  }
  return initialization;
}

self.onmessage = async ({ data }) => {
  const { frame, rotation, mirror, epoch, timestamp } = data;
  try {
    const segmenter = await initialize();
    const swapped = rotation % 180 !== 0;
    const sourceWidth = swapped ? frame.height : frame.width;
    const sourceHeight = swapped ? frame.width : frame.height;
    const scale = 256 / Math.max(sourceWidth, sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.setTransform(1, 0, 0, 1, width / 2, height / 2);
    if (mirror) context.scale(-1, 1);
    context.rotate(rotation * Math.PI / 180);
    const drawWidth = swapped ? height : width;
    const drawHeight = swapped ? width : height;
    context.drawImage(frame, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    lastTimestamp = Math.max(lastTimestamp + 1, timestamp);
    segmenter.segmentForVideo(canvas, lastTimestamp, result => {
      const masks = result.confidenceMasks;
      if (!masks?.length) throw new Error('Сегментатор не вернул маску');
      const mask = masks[masks.length - 1];
      const values = mask.getAsFloat32Array();
      const bytes = new Uint8Array(values.length);
      const smooth = previous?.epoch === epoch && previousWidth === mask.width && previousHeight === mask.height;
      for (let i = 0; i < bytes.length; i++) {
        const value = Math.max(0, Math.min(255, Math.round(values[i] * 255)));
        const old = smooth ? previous.bytes[i] : value;
        bytes[i] = Math.round(value * 0.78 + old * 0.22);
      }
      previous = { epoch, bytes: bytes.slice() };
      previousWidth = mask.width;
      previousHeight = mask.height;
      self.postMessage({ epoch, width: mask.width, height: mask.height, bytes }, [bytes.buffer]);
    });
  } catch (error) {
    self.postMessage({ epoch, error: error.message });
  } finally {
    frame.close();
  }
};
