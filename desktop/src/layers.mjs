import { Background } from './background.mjs';

const types = {
  camera: ['Камера', 'camera-video'], image: ['Изображение', 'image'],
  video: ['Видео', 'film'], text: ['Текст', 'type'], browser: ['Браузер', 'globe2']
};
const el = id => document.getElementById(id);
const accept = {
  image: 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp',
  video: 'video/mp4,video/webm'
};

function icon(name) {
  const element = document.createElement('i');
  element.className = 'bi bi-' + name;
  element.setAttribute('aria-hidden', 'true');
  return element;
}

export function reorder(items, sourceId, targetId, after) {
  if (sourceId === targetId) return items;
  const source = items.find(item => item.id === sourceId);
  if (!source || !items.some(item => item.id === targetId)) return items;
  const next = items.filter(item => item !== source);
  next.splice(next.findIndex(item => item.id === targetId) + Number(after), 0, source);
  return next;
}

export class LayerStack {
  constructor(compositor, api, changed) {
    this.compositor = compositor;
    this.api = api;
    this.changed = changed;
    this.items = [{
      id: 'camera', name: 'Камера', kind: 'camera', visible: true, x: 0, y: 0, width: 100, height: 100, opacity: 100
    }];
    this.connectControls();
    this.refresh();
  }

  drawables() {
    return this.items.filter(item => item.visible).reverse();
  }

  hasPicture(hasCamera) {
    return this.items.some(item => item.visible && item.opacity > 0 &&
      (item.kind === 'camera' ? hasCamera : this.compositor?.layers.has(item.id)));
  }

  connectControls() {
    for (const button of el('layerTypes').querySelectorAll('[data-kind]')) {
      button.addEventListener('click', () => {
        el('layerAdd').open = false;
        this.add(button.dataset.kind);
      });
    }
    el('layerDelete').addEventListener('click', () => this.remove());
    el('layerUp').addEventListener('click', () => this.step(-1));
    el('layerDown').addEventListener('click', () => this.step(1));
    el('layerFilePick').addEventListener('click', () => this.pick());
    el('layerFile').addEventListener('change', () => {
      const [file] = el('layerFile').files;
      const item = this.items.find(candidate => candidate.id === this.choosing);
      if (file && item) this.loadMedia(item, file);
      el('layerFile').value = '';
    });
    for (const key of ['x', 'y', 'width', 'height', 'opacity']) {
      el('layer-' + key).addEventListener('input', event => {
        const input = event.target;
        if (!this.selected || !Number.isFinite(input.valueAsNumber) || !input.validity.valid) return;
        this.selected[key] = input.valueAsNumber;
        if (this.selected.kind === 'text' && ['width', 'height'].includes(key)) this.paintText(this.selected);
        this.changed();
      });
    }
    for (const key of ['text', 'color', 'font']) {
      el('layer-' + key).addEventListener('input', event => {
        const input = event.target;
        if (this.selected?.kind !== 'text' || !input.validity.valid) return;
        this.selected[key] = key === 'font' ? input.valueAsNumber : input.value;
        if (key !== 'font' || Number.isFinite(this.selected.font)) this.paintText(this.selected);
      });
    }
    el('browserLoad').addEventListener('click', () => this.openBrowser());
    el('layer-url').addEventListener('keydown', event => {
      if (event.key === 'Enter') this.openBrowser();
    });
  }

  add(kind) {
    if (!types[kind] || kind === 'camera') return;
    const item = {
      id: crypto.randomUUID(), kind, name: types[kind][0], visible: true,
      x: 5, y: 5, width: 40, height: 34, opacity: 100,
      text: 'Текст', color: '#ffffff', font: 38, url: '', browserWidth: 960, browserHeight: 540
    };
    this.items.unshift(item);
    this.selected = item;
    this.refresh();
    if (kind === 'text') {
      this.paintText(item);
      el('layer-text').focus();
      el('layer-text').select();
    } else if (kind === 'browser') el('layer-url').focus();
    else this.pick();
  }

  pick() {
    if (!accept[this.selected?.kind]) return;
    this.choosing = this.selected.id;
    el('layerFile').accept = accept[this.selected.kind];
    el('layerFile').click();
  }

  loadMedia(item, file) {
    item.media?.clear();
    this.compositor?.clearLayer(item.id);
    item.error = '';
    const media = new Background((image, width, height) => {
      if (item.media !== media) return;
      this.compositor?.setLayerFrame(item.id, image, width, height);
      this.changed();
    }, message => this.reportError(item, message));
    item.media = media;
    item.name = file.name;
    this.refresh();
    this.changed();
    media.load(file).catch(error => {
      if (item.media === media) this.reportError(item, error.message);
    });
  }

  paintText(item) {
    const width = Math.max(16, Math.round(1280 * item.width / 100));
    const height = Math.max(16, Math.round(720 * item.height / 100));
    const surface = new OffscreenCanvas(width, height);
    const context = surface.getContext('2d');
    context.fillStyle = item.color;
    context.font = '600 ' + item.font + 'px system-ui';
    context.textBaseline = 'top';
    let y = 0;
    for (const line of item.text.split('\n')) {
      let row = '';
      for (const word of line.split(/\s+/)) {
        const candidate = row ? row + ' ' + word : word;
        if (row && context.measureText(candidate).width > width) {
          context.fillText(row, 1, y, width - 2);
          row = word;
          y += item.font * 1.2;
        } else row = candidate;
        if (y >= height) break;
      }
      if (y >= height) break;
      context.fillText(row, 1, y, width - 2);
      y += item.font * 1.2;
    }
    this.compositor?.setLayerFrame(item.id, surface, width, height);
    this.changed();
  }

  async openBrowser() {
    const item = this.selected;
    if (item?.kind !== 'browser') return;
    item.url = el('layer-url').value.trim();
    item.browserWidth = el('browserWidth').valueAsNumber;
    item.browserHeight = el('browserHeight').valueAsNumber;
    item.error = '';
    this.compositor?.clearLayer(item.id);
    this.changed();
    try {
      await this.api.browserOpen(item.id, item.url, item.browserWidth, item.browserHeight);
      if (!this.items.includes(item)) return;
      if (!item.visible) await this.api.browserVisibility(item.id, false);
    } catch (error) {
      this.reportError(item, error.message);
    }
    if (this.selected === item) this.edit();
  }

  browserFrame(event, bytes) {
    const item = this.items.find(candidate => candidate.id === event.id && candidate.kind === 'browser');
    if (!item || !item.visible || bytes.byteLength !== event.width * event.height * 4) return;
    this.compositor?.setLayerFrame(item.id, bytes, event.width, event.height, true);
    this.changed();
  }

  browserError(event) {
    const item = this.items.find(candidate => candidate.id === event.id);
    if (item) this.reportError(item, event.message);
  }

  reportError(item, message) {
    item.error = message;
    if (this.selected === item) this.edit();
  }

  step(direction) {
    const index = this.items.indexOf(this.selected);
    const target = this.items[index + direction];
    if (index < 0 || !target) return;
    this.items = reorder(this.items, this.selected.id, target.id, direction > 0);
    this.refresh();
    this.changed();
  }

  remove() {
    const item = this.selected;
    if (!item || item.kind === 'camera') return;
    const index = this.items.indexOf(item);
    this.items.splice(index, 1);
    item.media?.clear();
    if (item.kind === 'browser') this.api.browserClose(item.id).catch(() => {});
    this.compositor?.clearLayer(item.id);
    this.selected = this.items[Math.min(index, this.items.length - 1)];
    this.refresh();
    this.changed();
  }

  refresh() {
    const table = el('layerRows');
    table.replaceChildren(...this.items.map(item => {
      const row = document.createElement('li');
      row.draggable = true;
      row.dataset.selected = String(item === this.selected);
      row.dataset.id = item.id;
      row.className = 'layer-row';
      row.addEventListener('dragstart', event => {
        this.drag = item.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', item.id);
      });
      row.addEventListener('dragover', event => {
        if (!this.drag || this.drag === item.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const bounds = row.getBoundingClientRect();
        row.dataset.drop = event.clientY > bounds.top + bounds.height / 2 ? 'after' : 'before';
      });
      row.addEventListener('dragleave', () => delete row.dataset.drop);
      row.addEventListener('drop', event => {
        if (!this.drag) return;
        event.preventDefault();
        this.items = reorder(this.items, this.drag, item.id, row.dataset.drop === 'after');
        this.drag = null;
        this.refresh();
        this.changed();
      });
      row.addEventListener('dragend', () => {
        this.drag = null;
        for (const row of table.children) delete row.dataset.drop;
      });
      const grip = icon('grip-vertical');
      grip.classList.add('layer-grip');
      const name = document.createElement('button');
      name.className = 'layer-name';
      name.type = 'button';
      name.setAttribute('aria-pressed', String(item === this.selected));
      name.title = item.name;
      name.append(icon(types[item.kind][1]), document.createTextNode(item.name));
      name.addEventListener('click', () => {
        this.selected = item;
        for (const row of table.children) {
          row.dataset.selected = String(row.dataset.id === item.id);
          row.querySelector('.layer-name').setAttribute('aria-pressed', row.dataset.selected);
        }
        this.edit();
      });
      const eye = document.createElement('button');
      eye.className = 'icon-button layer-eye';
      eye.type = 'button';
      const syncEye = () => {
        eye.replaceChildren(icon(item.visible ? 'eye' : 'eye-slash'));
        eye.setAttribute('aria-pressed', String(item.visible));
        eye.title = item.visible ? 'Скрыть слой' : 'Показать слой';
        eye.setAttribute('aria-label', eye.title);
      };
      syncEye();
      eye.addEventListener('click', () => {
        item.visible = !item.visible;
        syncEye();
        if (item.kind === 'browser') this.api.browserVisibility(item.id, item.visible).catch(() => {});
        this.changed();
      });
      row.append(grip, name, eye);
      return row;
    }));
    this.edit();
  }

  edit() {
    const item = this.selected;
    el('layerEditor').hidden = !item;
    el('layerDelete').disabled = !item || item.kind === 'camera';
    el('layerUp').disabled = !item || item === this.items[0];
    el('layerDown').disabled = !item || item === this.items[this.items.length - 1];
    if (!item) return;
    el('layerMediaFields').hidden = !accept[item.kind];
    el('layerTextFields').hidden = item.kind !== 'text';
    el('layerBrowserFields').hidden = item.kind !== 'browser';
    el('layerError').hidden = !item.error;
    el('layerError').textContent = item.error || '';
    for (const key of ['x', 'y', 'width', 'height', 'opacity', 'text', 'color', 'font', 'url']) {
      if (item[key] !== undefined) el('layer-' + key).value = item[key];
    }
    if (item.kind === 'browser') {
      el('browserWidth').value = item.browserWidth;
      el('browserHeight').value = item.browserHeight;
    }
  }
}
