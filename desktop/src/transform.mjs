const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function transform(box, handle, dx, dy) {
  const { x, y, width, height } = box;
  if (!handle) return { x: clamp(x + dx, 1 - width, 99), y: clamp(y + dy, 1 - height, 99), width, height };
  const left = handle.includes('w'), top = handle.includes('n');
  let w = /[we]/.test(handle) ? clamp(width + (left ? -dx : dx), 1, 400) : width;
  let h = /[ns]/.test(handle) ? clamp(height + (top ? -dy : dy), 1, 400) : height;
  if (handle.length === 2) {
    const factor = clamp(Math.abs(w / width - 1) >= Math.abs(h / height - 1) ? w / width : h / height,
      Math.max(1 / width, 1 / height), Math.min(400 / width, 400 / height));
    w = width * factor;
    h = height * factor;
  }
  return { x: left ? x + width - w : x, y: top ? y + height - h : y, width: w, height: h };
}

// Screen-pixel tolerance stays constant when the preview is resized.
export function snapToFrame(start, next, handle, viewport, tolerance = 8) {
  const nearest = (values, length) => values.flatMap(value => [0 - value, 100 - value])
    .filter(delta => Math.abs(delta) * length / 100 <= tolerance)
    .sort((a, b) => Math.abs(a) - Math.abs(b))[0];
  const { x, y, width, height } = next;
  if (!handle) {
    return { ...next, x: x + (nearest([x, x + width], viewport.width) ?? 0),
      y: y + (nearest([y, y + height], viewport.height) ?? 0) };
  }

  const horizontal = /[we]/.test(handle), vertical = /[ns]/.test(handle);
  const left = handle.includes('w'), top = handle.includes('n');
  const dx = horizontal ? nearest([left ? x : x + width], viewport.width) : undefined;
  const dy = vertical ? nearest([top ? y : y + height], viewport.height) : undefined;
  let w = width, h = height;
  if (handle.length === 1) {
    w += (left ? -1 : 1) * (dx ?? 0);
    h += (top ? -1 : 1) * (dy ?? 0);
  } else {
    const useX = dx !== undefined && (dy === undefined || Math.abs(dx) * viewport.width <= Math.abs(dy) * viewport.height);
    if (useX) {
      w += (left ? -1 : 1) * dx;
      h = w * start.height / start.width;
    } else if (dy !== undefined) {
      h += (top ? -1 : 1) * dy;
      w = h * start.width / start.height;
    }
  }
  if (w < 1 || h < 1 || w > 400 || h > 400) return next;
  return { x: left ? x + width - w : x, y: top ? y + height - h : y, width: w, height: h };
}

export class CanvasEditor {
  constructor(stack) {
    this.stack = stack;
    this.canvas = document.getElementById('canvas');
    this.area = document.getElementById('transformArea');
    this.box = document.getElementById('selection');
    for (const handle of handles) {
      const grip = document.createElement('i');
      grip.dataset.handle = handle;
      this.box.append(grip);
    }
    this.area.onpointerdown = event => this.begin(event);
    this.area.onpointermove = event => this.move(event);
    this.area.onpointercancel = this.area.onpointerup = event => {
      if (event.pointerId !== this.gesture?.pointer) return;
      this.gesture = null;
      delete this.area.dataset.snap;
    };
    new ResizeObserver(() => this.sync()).observe(this.canvas.parentElement);
  }

  sync() {
    const { canvas, area, box } = this;
    area.hidden = canvas.hidden;
    if (area.hidden) return;
    const scale = Math.min(canvas.clientWidth / canvas.width, canvas.clientHeight / canvas.height);
    area.style.width = canvas.width * scale + 'px';
    area.style.height = canvas.height * scale + 'px';
    const item = this.stack.selected;
    box.hidden = !item?.visible;
    if (box.hidden) return;
    Object.assign(box.style, { left: item.x + '%', top: item.y + '%', width: item.width + '%', height: item.height + '%' });
  }

  begin(event) {
    if (event.button !== 0 || this.gesture) return;
    const bounds = this.area.getBoundingClientRect();
    const x = 100 * (event.clientX - bounds.left) / bounds.width;
    const y = 100 * (event.clientY - bounds.top) / bounds.height;
    const handle = event.target.dataset.handle;
    const item = handle ? this.stack.selected : this.stack.items.find(layer =>
      layer.visible && layer.opacity && x >= layer.x && x <= layer.x + layer.width && y >= layer.y && y <= layer.y + layer.height);
    this.stack.selected = item;
    this.stack.refresh();
    if (!item) return;
    event.preventDefault();
    this.area.setPointerCapture(event.pointerId);
    this.gesture = { item, pointer: event.pointerId, handle, bounds, x: event.clientX, y: event.clientY,
      box: { x: item.x, y: item.y, width: item.width, height: item.height } };
  }

  move(event) {
    const g = this.gesture;
    if (!g || event.pointerId !== g.pointer) return;
    const dx = 100 * (event.clientX - g.x) / g.bounds.width;
    const dy = 100 * (event.clientY - g.y) / g.bounds.height;
    const moved = transform(g.box, g.handle, dx, dy);
    const values = event.altKey ? moved : snapToFrame(g.box, moved, g.handle, g.bounds);
    this.area.dataset.snap = Object.keys(values).some(key => Math.abs(values[key] - moved[key]) > 0.001)
      ? 'true' : 'false';
    for (const key of Object.keys(values)) g.item[key] = Math.round(values[key] * 10) / 10;
    if (g.handle?.length === 1) g.item.stretch = true;
    this.stack.edit();
    this.stack.changed();
  }
}
