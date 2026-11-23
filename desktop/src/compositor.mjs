const vertexSource = `#version 300 es
out vec2 point;
void main() {
  vec2 vertex = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(vertex, 0.0, 1.0);
  point = vertex * .5 + .5;
}`;

const compositeSource = `#version 300 es
precision highp float;
in vec2 point;
out vec4 result;
uniform sampler2D cameraImage;
uniform sampler2D personMask;
uniform sampler2D backgroundImage;
uniform int rotation;
uniform int effect;
uniform bool mirror;
uniform bool hasMask;
uniform bool hasBackground;
uniform vec2 backgroundCrop;
uniform vec2 blurStep;
uniform vec3 keyColor;
uniform float tolerance;
uniform float maskThreshold;
uniform vec3 adjustments;
uniform bool mono;

vec2 cameraUV(vec2 p) {
  p = vec2(mirror ? 1.0 - p.x : p.x, p.y);
  if (rotation == 90) return vec2(p.y, 1.0 - p.x);
  if (rotation == 180) return 1.0 - p;
  if (rotation == 270) return vec2(1.0 - p.y, p.x);
  return p;
}
vec3 camera(vec2 uv) { return texture(cameraImage, cameraUV(uv)).rgb; }
vec2 chroma(vec3 rgb) {
  return vec2(dot(rgb, vec3(-.169, -.331, .5)), dot(rgb, vec3(.5, -.419, -.081)));
}
vec3 blurBackground(vec2 uv) {
  vec3 color = camera(uv) * .16;
  for (int i = 0; i < 8; i++) {
    float angle = float(i) * .78539816;
    vec2 direction = vec2(cos(angle), sin(angle));
    color += camera(uv + direction * blurStep) * .07;
    color += camera(uv + direction * blurStep * .42) * .035;
  }
  return color;
}
void main() {
  vec2 uv = vec2(point.x, 1.0 - point.y);
  vec3 foreground = camera(uv);
  float alpha = 1.0;
  if (effect == 1) {
    float distanceToKey = length(chroma(foreground) - chroma(keyColor));
    alpha = smoothstep(tolerance * .65, tolerance + .045, distanceToKey);
    vec3 keyDirection = max(vec3(0.0), keyColor - vec3(min(keyColor.r, min(keyColor.g, keyColor.b))));
    foreground = max(vec3(0.0), foreground - keyDirection * (1.0 - alpha) * .23);
  }
  if ((effect == 2 || effect == 3) && hasMask) {
    alpha = smoothstep(maskThreshold - .12, maskThreshold + .12, texture(personMask, uv).r);
  }
  foreground = (foreground - .5) * adjustments.y + .5 + adjustments.x;
  foreground = mix(vec3(dot(foreground, vec3(.2126, .7152, .0722))), foreground, mono ? 0.0 : adjustments.z);
  if (effect == 3 && hasMask) {
    result = vec4(mix(blurBackground(uv), foreground, alpha), 1.0);
  } else if ((effect == 1 || effect == 2) && hasBackground) {
    vec3 bg = texture(backgroundImage, (uv - .5) * backgroundCrop + .5).rgb;
    result = vec4(mix(bg, foreground, alpha), 1.0);
  } else {
    result = vec4(foreground, alpha);
  }
}`;

const packSource = `#version 300 es
precision highp float;
out vec4 result;
uniform sampler2D fullColor;
uniform vec2 outputSize;
uniform vec2 imageScale;
const vec3 yCoefficients = vec3(.2126, .7152, .0722);
const vec3 uCoefficients = vec3(-.11457, -.38543, .5);
const vec3 vCoefficients = vec3(.5, -.45415, -.04585);

vec3 source(vec2 pixel) {
  vec2 uv = ((pixel + .5) / outputSize - .5) / imageScale + .5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
  vec4 color = texture(fullColor, vec2(uv.x, 1.0 - uv.y));
  return color.rgb * color.a;
}
float luminance(vec2 pixel) {
  return (16.0 + 219.0 * dot(source(pixel), yCoefficients)) / 255.0;
}
vec2 chrominance(vec2 pixel) {
  vec3 rgb = (source(pixel) + source(pixel + vec2(1,0)) +
    source(pixel + vec2(0,1)) + source(pixel + vec2(1,1))) * .25;
  return (vec2(128.0) + 224.0 * vec2(dot(rgb, uCoefficients), dot(rgb, vCoefficients))) / 255.0;
}
void main() {
  vec2 pixel = floor(gl_FragCoord.xy);
  pixel.x *= 4.0;
  if (pixel.y < outputSize.y) {
    result = vec4(luminance(pixel), luminance(pixel + vec2(1,0)),
      luminance(pixel + vec2(2,0)), luminance(pixel + vec2(3,0)));
  } else {
    pixel.y = (pixel.y - outputSize.y) * 2.0;
    result = vec4(chrominance(pixel), chrominance(pixel + vec2(2,0)));
  }
}`;

function program(gl, fragment, names) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const pixel = compile(gl.FRAGMENT_SHADER, fragment);
  const id = gl.createProgram();
  gl.attachShader(id, vertex);
  gl.attachShader(id, pixel);
  gl.linkProgram(id);
  gl.deleteShader(vertex);
  gl.deleteShader(pixel);
  if (!gl.getProgramParameter(id, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(id));
  return { id, uniforms: Object.fromEntries(names.map(name => [name, gl.getUniformLocation(id, name)])) };
}

export class Compositor {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false, depth: false });
    if (!gl) throw new Error('WebGL 2 недоступен. Проверьте видеодрайвер.');
    this.gl = gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.disable(gl.DITHER);
    gl.bindVertexArray(gl.createVertexArray());
    this.composite = program(gl, compositeSource, [
      'cameraImage', 'personMask', 'backgroundImage', 'rotation', 'effect', 'mirror', 'hasMask',
      'hasBackground', 'backgroundCrop', 'blurStep', 'keyColor', 'tolerance', 'maskThreshold', 'adjustments', 'mono'
    ]);
    this.pack = program(gl, packSource, ['fullColor', 'outputSize', 'imageScale']);
    this.source = this.texture(gl.LINEAR);
    this.mask = this.texture(gl.LINEAR);
    this.background = this.texture(gl.LINEAR);
    this.scene = { texture: this.texture(gl.LINEAR), fbo: gl.createFramebuffer() };
    this.packed = { texture: this.texture(gl.NEAREST), fbo: gl.createFramebuffer() };
    for (const texture of [this.mask, this.background]) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    }
  }

  texture(filter) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  resize(target, width, height) {
    if (target.width === width && target.height === height) return;
    const gl = this.gl;
    target.width = width;
    target.height = height;
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Не удалось выделить видеобуфер (' + status.toString(16) + ', ' + gl.getError() + ', ' + width + '×' + height + ')');
    }
  }

  upload(texture, image, width, height) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
  }

  loadMask({ bytes, width, height }) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
    this.hasMask = true;
  }

  loadBackground(image, width, height) {
    this.upload(this.background, image, width, height);
    this.backgroundRatio = width / height;
  }

  loadFrame(frame, rotation) {
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    const sideways = rotation % 180 !== 0;
    const outputWidth = sideways ? height : width;
    const outputHeight = sideways ? width : height;
    if (this.canvas.width !== outputWidth) this.canvas.width = outputWidth;
    if (this.canvas.height !== outputHeight) this.canvas.height = outputHeight;
    this.upload(this.source, frame, width, height);
    this.hasFrame = true;
  }

  bind(texture, unit, uniform) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uniform, unit);
  }

  draw(settings) {
    if (!this.hasFrame) return;
    const gl = this.gl;
    const { width, height } = this.canvas;
    this.resize(this.scene, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.composite.id);
    const u = this.composite.uniforms;
    this.bind(this.source, 0, u.cameraImage);
    this.bind(this.mask, 1, u.personMask);
    this.bind(this.background, 2, u.backgroundImage);
    gl.uniform1i(u.rotation, settings.rotation);
    gl.uniform1i(u.effect, settings.effect);
    gl.uniform1i(u.mirror, Number(settings.mirror));
    gl.uniform1i(u.hasMask, Number(Boolean(this.hasMask)));
    gl.uniform1i(u.hasBackground, Number(Boolean(this.backgroundRatio)));
    const ratio = width / height;
    const bgRatio = this.backgroundRatio || ratio;
    gl.uniform2f(u.backgroundCrop, Math.min(1, ratio / bgRatio), Math.min(1, bgRatio / ratio));
    gl.uniform2f(u.blurStep, settings.blur / width, settings.blur / height);
    gl.uniform3fv(u.keyColor, settings.key);
    gl.uniform1f(u.tolerance, settings.tolerance);
    gl.uniform1f(u.maskThreshold, settings.maskThreshold);
    gl.uniform3fv(u.adjustments, settings.adjustments);
    gl.uniform1i(u.mono, Number(settings.mono));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.present();
  }

  present() {
    const gl = this.gl;
    const { width, height } = this.canvas;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.scene.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  nv12(width, height) {
    const gl = this.gl;
    const packedWidth = width / 4;
    const packedHeight = height * 1.5;
    this.resize(this.packed, packedWidth, packedHeight);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.packed.fbo);
    gl.viewport(0, 0, packedWidth, packedHeight);
    gl.useProgram(this.pack.id);
    const u = this.pack.uniforms;
    this.bind(this.scene.texture, 0, u.fullColor);
    gl.uniform2f(u.outputSize, width, height);
    const ratio = this.scene.width / this.scene.height;
    const outputRatio = width / height;
    gl.uniform2f(u.imageScale, Math.min(1, ratio / outputRatio), Math.min(1, outputRatio / ratio));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!this.outputBytes || this.outputBytes.length !== width * height * 1.5) {
      this.outputBytes = new Uint8Array(width * height * 1.5);
    }
    gl.readPixels(0, 0, packedWidth, packedHeight, gl.RGBA, gl.UNSIGNED_BYTE, this.outputBytes);
    return this.outputBytes.buffer;
  }
}
