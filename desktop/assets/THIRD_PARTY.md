# Сторонние компоненты

- **Electron** включает Chromium и Node.js. Лицензии поставляются с Windows-приложением. [Electron](https://www.electronjs.org/)
- **MediaPipe Tasks Vision** и модель **Selfie Segmenter** от Google обрабатывают маску человека локально. MediaPipe распространяется по Apache License 2.0. [MediaPipe](https://github.com/google-ai-edge/mediapipe) · [Модель](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) · [Лицензия](APACHE-2.0.txt)
- **OBS Virtual Camera** устанавливается отдельно. Нативный модуль FrameLink передаёт NV12 в очередь совместимого формата. [Исходный код OBS Virtual Camera](https://github.com/obsproject/obs-studio/blob/31.0.4/plugins/win-dshow/shared-memory-queue.c)
