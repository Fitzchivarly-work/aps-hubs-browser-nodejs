
/* global Autodesk, THREE */
/**
 * ELIN Stamp Extension
 * - Loads stamps dynamically from /stamps.json
 * - Stamp picker with search
 * - Place stamps in 2D (DWG/PDF) and 3D
 * - Select (Shift/Ctrl multi-select), drag to move, resize handle to scale
 * - Delete selected stamps (fixed)
 * - Convert selected stamps to ACC Issues (/api/issues/create)
 *
 * Requirements:
 * - stamps.json must be served from /stamps.json (put into wwwroot/stamps.json)
 */

(function () {
  'use strict';

  const USE_2D_VECTOR_PIN = !!(window.ELIN_FLAGS && window.ELIN_FLAGS.USE_2D_VECTOR_PIN);
  const DEFAULT_STAMP_COLOR = '#C00000';
  const DEFAULT_STROKE_WIDTH = 15;

  // ----------------------------- Small utilities -----------------------------
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function uid() {
    return 'stamp-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2);
  }

  function safeClosest(el, sel) {
    if (!el || !el.closest) return null;
    return el.closest(sel);
  }

  function vecToPlain(v) {
    return { x: Number(v.x) || 0, y: Number(v.y) || 0, z: (typeof v.z === 'number' ? v.z : 0) };
  }

  function plainToVec3(p) {
    if (!p) return new THREE.Vector3(0, 0, 0);
    return new THREE.Vector3(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
  }

  function isFinitePoint(p) {
    return p && Number.isFinite(p.x) && Number.isFinite(p.y);
  }

  function angleDegBetweenPoints(cx, cy, px, py) {
    return Math.atan2(py - cy, px - cx) * (180 / Math.PI);
  }

  function tryDecodeBase64ToText(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
      const pad = normalized.length % 4;
      const padded = pad ? (normalized + '='.repeat(4 - pad)) : normalized;
      return atob(padded);
    } catch (e) {
      return '';
    }
  }

  function normalizeStorageUrn(rawUrn) {
    const raw = String(rawUrn || '').trim();
    if (!raw) return 'unknownUrn';

    let decodedUrl = raw;
    try { decodedUrl = decodeURIComponent(raw); } catch (e) { /* ignore */ }
    if (/^urn:adsk\./i.test(decodedUrl)) return decodedUrl;

    const b64Decoded = tryDecodeBase64ToText(decodedUrl);
    if (/^urn:adsk\./i.test(b64Decoded)) return b64Decoded;

    return decodedUrl;
  }

  // ----------------------------- Stamp definition loader -----------------------------
  class StampLibrary {
    constructor(url) {
      const raw = String(url || '/stamps.json').trim();
      this.url = raw.startsWith('/') ? raw : `/${raw}`;
      this.loaded = false;
      this.error = null;
      this.map = new Map(); // key -> { key, label, viewBox, svg, accMarkupSvg, width, height }
      this.list = []; // array of defs sorted by key
    }

    async load() {
      this.loaded = false;
      this.error = null;
      this.map.clear();
      this.list = [];

      try {
        const cacheBustedUrl = this._withCacheBuster(this.url);
        const res = await fetch(cacheBustedUrl, { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText} beim Laden von ${cacheBustedUrl}`);
        }

        let json;
        try {
          json = await res.json();
        } catch (parseErr) {
          console.error('[ELIN] stamps.json JSON Parse Error', {
            url: cacheBustedUrl,
            message: parseErr && parseErr.message ? parseErr.message : String(parseErr)
          });
          throw new Error(`JSON Parse Error in ${cacheBustedUrl}: ${parseErr.message || parseErr}`);
        }

        const addDef = (key, def) => {
          if (!key || !def) return;

          const normalized = this._normalizeSvgDefinition(def);
          if (!normalized) {
            console.warn(`[ELIN] Ungueltige Stamp-Definition uebersprungen: ${key}`);
            return;
          }

          this.map.set(String(key), {
            key: String(key),
            label: def.label || '',
            viewBox: normalized.viewBox,
            svg: normalized.svg,
            accMarkupSvg: normalized.accMarkupSvg,
            width: normalized.width,
            height: normalized.height
          });
        };

        if (Array.isArray(json)) {
          for (const item of json) addDef(item && (item.key || item.id), item);
        } else if (json && typeof json === 'object') {
          Object.keys(json).forEach((key) => addDef(key, json[key]));
        } else {
          throw new Error('stamps.json hat kein gültiges Format (Objekt oder Array erwartet).');
        }

        this.list = Array.from(this.map.values()).sort((a, b) => a.key.localeCompare(b.key));
        this.loaded = true;
      } catch (e) {
        this.error = e;
        this.loaded = false;
        console.error('[ELIN] stamps.json konnte nicht geladen werden', {
          url: this.url,
          message: e && e.message ? e.message : String(e)
        });
      }
      return this.loaded;
    }

    _withCacheBuster(url) {
      const sep = String(url).includes('?') ? '&' : '?';
      return `${url}${sep}v=${Date.now()}`;
    }

    _normalizeSvgDefinition(def) {
      const rawViewBox = typeof def.viewBox === 'string' ? def.viewBox.trim() : '';
      const rawSvg = typeof def.svg === 'string' ? def.svg.trim() : '';
      const rawAccMarkupSvg = typeof def.accMarkupSvg === 'string' ? def.accMarkupSvg.trim() : '';

      const svgParts = this._extractSvgParts(rawSvg || rawAccMarkupSvg);
      const viewBox = rawViewBox || svgParts.viewBox || '';
      const svg = svgParts.innerSvg || '';

      if (!viewBox || !svg) return null;

      const accMarkupSvg = rawAccMarkupSvg || `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${svg}</svg>`;
      const width = Number(def.width) || 0;
      const height = Number(def.height) || 0;

      return { viewBox, svg, accMarkupSvg, width, height };
    }

    _extractSvgParts(svgText) {
      const text = typeof svgText === 'string' ? svgText.trim() : '';
      if (!text) return { viewBox: '', innerSvg: '' };

      const svgTagMatch = text.match(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/i);
      if (!svgTagMatch) {
        return { viewBox: '', innerSvg: text };
      }

      const attrs = svgTagMatch[1] || '';
      const innerSvg = (svgTagMatch[2] || '').trim();
      const viewBoxMatch = attrs.match(/viewBox\s*=\s*["']([^"']+)["']/i);
      const viewBox = viewBoxMatch ? String(viewBoxMatch[1]).trim() : '';
      return { viewBox, innerSvg };
    }

    get(key) { return this.map.get(String(key)) || null; }

    search(query, limit) {
      const max = Number.isFinite(limit) ? limit : 120;
      const q = (query || '').trim().toLowerCase();
      if (!q) return this.list.slice(0, max);

      const out = [];
      for (const d of this.list) {
        const hay = (d.key + ' ' + (d.label || '')).toLowerCase();
        if (hay.includes(q)) out.push(d);
        if (out.length >= max) break;
      }
      return out;
    }
  }

  // ----------------------------- Main Extension -----------------------------
  class ElinStampExtension extends Autodesk.Viewing.Extension {
    constructor(viewer, options) {
      super(viewer, options);

      this.options = options || {};

      // Data
      this._library = new StampLibrary(this.options.stampsUrl || '/stamps.json');
      this._stamps = [];
      this._selected = [];
      this._activeStampKey = null;

      // State
      this._placing = false;
      this._dragState = null;
      this._defaultIssueType = 'allgemein';
      this._issueSubtypeOptions = [];
      this._defaultIssueSubtypeId = null;
      this._lastCompleteTreeCtx = null;
      this._pickerPanel = null;
      this._propsPanel = null;
      this._launcherBtn = null;
      this._styleEl = null;
      this._libraryLoading = false;
      this._ignoreNextContainerClick = false;
      this._multiSelectMode = false;
      this._panelDragState = null;

      // Config
      this._baseSizePx = Number(this.options.baseSizePx) || 40;
      this._minScale = Number(this.options.minScale) || 0.25;
      this._maxScale = Number(this.options.maxScale) || 6;
      this._ctxMenuId = 'elin-stamp-menu';
      this._acc2dYMode = this.options.acc2dYMode || 'bbox-min'; // 'bbox-min' | 'bbox-max-inverted'
      this._acc2dInvertY = this.options.acc2dInvertY !== false;

      // Bound handlers
      this._onCameraChange = () => this._updateAllStamps();
      this._onModelLoaded = () => {
        this._onModelRootLoaded().catch((e) => {
          console.warn('[ELIN] Model load sync failed:', e);
        });
      };
      this._onKeyDownBound = (ev) => this._handleKeyDown(ev);
      this._onContainerPointerDownCaptureBound = (ev) => this._handleContainerPointerDownCapture(ev);
      this._onContainerPointerUpCaptureBound = () => {
        if (this._ignoreNextContainerClick) this._ignoreNextContainerClick = false;
      };
    }

    load() {
      this._injectStyles();
      this._createLauncherButton();
      this._createPickerPanel();
      this._createPropertiesPanel();

      this.viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, this._onCameraChange);
      this.viewer.addEventListener(Autodesk.Viewing.MODEL_ROOT_LOADED_EVENT, this._onModelLoaded);

      this.viewer.container.addEventListener('pointerdown', this._onContainerPointerDownCaptureBound, true);
      this._onEscapeKeyBound = (ev) => this._onEscapeKey(ev);
      window.addEventListener('keydown', this._onEscapeKeyBound);
      this.viewer.container.addEventListener('pointerup', this._onContainerPointerUpCaptureBound, true);
      window.addEventListener('keydown', this._onKeyDownBound, true);

      // Right click menu: keep Autodesk items and add ELIN items
      this.viewer.registerContextMenuCallback(this._ctxMenuId, (menu) => {
        menu.addMenuItem('ELIN: Stempel-Bibliothek öffnen', () => {
          this._togglePicker(true);
          this._ensureLibraryLoaded();
        });

        if (this._selected.length > 0) {
          menu.addMenuItem(`ELIN: ${this._selected.length} Stempel in ACC Aufgabe umwandeln`, () => {
            this._sendSelectedToAcc().catch((e) => {
              console.error(e);
              alert('ACC Fehler: ' + e.message);
            });
          });
          menu.addMenuItem(`ELIN: ${this._selected.length} Stempel löschen`, () => {
            this._deleteSelectedStamps();
          });
        }
      });

      // Initialisiere model-abhaengige Daten erst, wenn das Model wirklich da ist.
      if (this.viewer.model) {
        this._onModelRootLoaded().catch((e) => {
          console.warn('[ELIN] Initial model sync failed:', e);
        });
      }

      return true;
    }

    unload() {
      this.viewer.removeEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, this._onCameraChange);
      this.viewer.removeEventListener(Autodesk.Viewing.MODEL_ROOT_LOADED_EVENT, this._onModelLoaded);

      try { this.viewer.unregisterContextMenuCallback(this._ctxMenuId); } catch (e) { /* ignore */ }

      this.viewer.container.removeEventListener('pointerdown', this._onContainerPointerDownCaptureBound, true);
      if (this._onEscapeKeyBound) window.removeEventListener('keydown', this._onEscapeKeyBound);
      this.viewer.container.removeEventListener('pointerup', this._onContainerPointerUpCaptureBound, true);
      window.removeEventListener('keydown', this._onKeyDownBound, true);

      this._clearSelection();
      this._clearAllStampsDom();

      if (this._pickerPanel) { this._pickerPanel.remove(); this._pickerPanel = null; }
      if (this._propsPanel) { this._propsPanel.remove(); this._propsPanel = null; }
      if (this._launcherBtn) { this._launcherBtn.remove(); this._launcherBtn = null; }
      if (this._styleEl) { this._styleEl.remove(); this._styleEl = null; }

      if (this.viewer && this.viewer.canvas) this.viewer.canvas.style.cursor = 'default';
      return true;
    }

    // -------------------- Helpers (keine externen Imports nötig) --------------------
    _toInt(n, fallback) {
      const v = Number(n);
      return Number.isFinite(v) ? Math.round(v) : (fallback || 0);
    }

    _is2DModel() {
      const model = this.viewer && this.viewer.model;
      if (!model) return false;
      
      // Methode 1: is2d() Funktion
      try {
        if (typeof model.is2d === 'function') {
          const result = model.is2d();
          console.log('[ELIN] 2D Detection (model.is2d):', result);
          return !!result;
        }
      } catch (e) { /* ignore */ }
      
      // Methode 2: getData().is2d
      const data = model.getData && model.getData();
      if (data && typeof data.is2d === 'boolean') {
        console.log('[ELIN] 2D Detection (getData):', data.is2d);
        return data.is2d;
      }
      
      // Methode 3: Fallback über geometry type
      try {
        const geom = this.viewer.model.getGeometryList && this.viewer.model.getGeometryList();
        if (geom && geom.is2d !== undefined) {
          console.log('[ELIN] 2D Detection (geometry):', geom.is2d);
          return !!geom.is2d;
        }
      } catch (e) { /* ignore */ }
      
      console.warn('[ELIN] 2D Detection failed - assuming 3D');
      return false;
    }

    _getAcc2DPosition(worldPos) {
      const model = this.viewer && this.viewer.model;
      if (!model) return this._toPlainPos(worldPos);

      const m = this._get2DSheetMetrics();
      if (!m || !m.valid) return this._toPlainPos(worldPos);

      const clamp01 = (n) => Math.max(0, Math.min(1, n));
      const toPrecise = (n) => {
        const v = Number(n);
        if (!Number.isFinite(v)) return 0;
        return Math.round(v * 1000) / 1000;
      };

      const nxRaw = (Number(worldPos.x) - m.minX) / m.width;
      const nyRaw = (Number(worldPos.y) - m.minY) / m.height;
      const nx = clamp01(nxRaw);
      const nyModel = clamp01(nyRaw);

      const xAbs = nx * m.pageWidth;
      const yAbs = nyModel * m.pageHeight;
      return { x: toPrecise(xAbs), y: toPrecise(yAbs), z: 0 };
    }

    _getAcc2DNormalizedPosition(worldPos) {
      const m = this._get2DSheetMetrics();
      if (!m || !m.valid) return { x: 0, y: 0, z: 0 };

      const clamp01 = (n) => Math.max(0, Math.min(1, n));
      const nxRaw = (Number(worldPos.x) - m.minX) / m.width;
      const nyRaw = (Number(worldPos.y) - m.minY) / m.height;
      const nx = clamp01(nxRaw);
      const nyModel = clamp01(nyRaw);

      return {
        x: Math.round(nx * 1000000) / 1000000,
        y: Math.round(nyModel * 1000000) / 1000000,
        z: 0
      };
    }

    _get2DSheetMetrics() {
      const model = this.viewer && this.viewer.model;
      if (!model) return null;

      const data = model.getData && model.getData();
      const md = data && data.metadata ? data.metadata : {};

      const bbox = (data && data.bbox) || (model.getBoundingBox && model.getBoundingBox()) || null;
      if (!bbox || !bbox.min || !bbox.max) return null;

      const minX = Number(bbox.min.x);
      const minY = Number(bbox.min.y);
      const maxX = Number(bbox.max.x);
      const maxY = Number(bbox.max.y);
      const width = maxX - minX;
      const height = maxY - minY;

      const pageW = Number(md.page_width || md.pageWidth || md.width || md.sheetWidth || width);
      const pageH = Number(md.page_height || md.pageHeight || md.height || md.sheetHeight || height);

      return {
        valid: Number.isFinite(minX) && Number.isFinite(minY)
          && Number.isFinite(width) && width > 0
          && Number.isFinite(height) && height > 0
          && Number.isFinite(pageW) && pageW > 0
          && Number.isFinite(pageH) && pageH > 0,
        minX,
        minY,
        width,
        height,
        pageWidth: pageW,
        pageHeight: pageH
      };
    }

    _toPlainPos(v) {
      if (!v) return { x: 0, y: 0, z: 0 };
      return { x: Number(v.x) || 0, y: Number(v.y) || 0, z: Number(v.z) || 0 };
    }

    /**
     * Berechnet den aktuellen Zoom-Faktor (Pixel pro Welteinheit).
     * Wird für absolute Skalierung in 2D verwendet.
     * @returns {number} Pixel pro Welteinheit
     */
    _getCurrentZoomFactor() {
      try {
        // Zwei Punkte im Welt-Koordinatensystem (100 Einheiten auseinander)
        const worldP1 = new THREE.Vector3(0, 0, 0);
        const worldP2 = new THREE.Vector3(100, 0, 0);

        // In Bildschirm-Koordinaten konvertieren
        const screenP1 = this.viewer.worldToClient(worldP1);
        const screenP2 = this.viewer.worldToClient(worldP2);

        if (!screenP1 || !screenP2 || !Number.isFinite(screenP1.x) || !Number.isFinite(screenP2.x)) {
          return 1; // Fallback
        }

        // Pixel-Distanz
        const dx = screenP2.x - screenP1.x;
        const dy = screenP2.y - screenP1.y;
        const pixelDist = Math.sqrt(dx * dx + dy * dy);

        // Pixel pro Welteinheit (100 Welteinheiten = pixelDist Pixel)
        return pixelDist / 100;
      } catch (e) {
        console.warn('[ELIN] Zoom factor calculation failed:', e);
        return 1;
      }
    }

    async _ensureLibraryLoaded() {
      if (this._library.loaded || this._libraryLoading) {
        this._refreshLibraryUI();
        return this._library.loaded;
      }

      this._libraryLoading = true;
      this._refreshLibraryUI('Lade stamps.json …');
      try {
        const ok = await this._library.load();
        if (!ok && this._library.error) {
          console.error('ELIN: stamps.json konnte nicht geladen werden', this._library.error);
        } else {
          this._rerenderAllStampSvgs();
          if (!this._activeStampKey && this._library.list.length > 0) {
            this._activeStampKey = this._library.list[0].key;
          }
        }
      } finally {
        this._libraryLoading = false;
        this._refreshLibraryUI();
      }
      return this._library.loaded;
    }

    _rerenderAllStampSvgs() {
      for (const s of this._stamps) {
        const def = this._library.get(s.stampKey);
        s.label = def ? (def.label || '') : (s.label || '');
        this._refreshStampHtml(s);
      }
    }

    _applyStampStyle(svgText, stampColor, strokeWidth) {
      const svg = String(svgText || '');
      let out = svg;

      if (stampColor) {
        out = out.replace(/stroke=(["'])#[0-9a-fA-F]+\1/gi, `stroke="${stampColor}"`);
        out = out.replace(/fill=(["'])(#[0-9a-fA-F]+|none)\1/gi, (m, _q, fillValue) => {
          if (String(fillValue || '').toLowerCase() === 'none') return m;
          return `fill="${stampColor}"`;
        });
      }

      if (typeof strokeWidth === 'number' && Number.isFinite(strokeWidth)) {
        out = out.replace(/stroke-width=(["'])[0-9.]+\1/gi, `stroke-width="${strokeWidth}"`);
      }

      return out;
    }

    _refreshStampHtml(stamp) {
      if (!stamp || !stamp.el) return;
      const body = stamp.el.querySelector('.elin-stamp__body');
      if (!body) return;
      const def = this._library.get(stamp.stampKey);
      body.innerHTML = this._getStampBodySvgHtml(def, stamp.color, stamp.strokeWidth);
    }

    _getStampBodySvgHtml(def, stampColor, strokeWidth) {
      if (def) {
        const colorizedSvg = this._applyStampStyle(def.svg, stampColor, strokeWidth);
        return `<svg class="elin-stamp__svg" viewBox="${def.viewBox}" xmlns="http://www.w3.org/2000/svg">${colorizedSvg}</svg>`;
      }
      return `<svg class="elin-stamp__svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="5" width="90" height="90" fill="none" stroke="#ff0000" stroke-width="5"/>
        <text x="50" y="58" text-anchor="middle" font-size="16" fill="#ff0000">NO LIB</text>
      </svg>`;
    }

    // ----------------------------- UI: launcher button -----------------------------
    _createLauncherButton() {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'elin-launcher-btn';
      btn.textContent = 'ELIN Stempel';
      btn.title = 'Stempel-Bibliothek öffnen';

      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        // Toggle placing mode directly from the launcher button on tablet.
        if (this._placing) {
          this._setPlacingMode(false);
          this._activeStampKey = null;
          if (this._pickerPanel && this._pickerPanel.style.display !== 'none') this._togglePicker(false);
          return;
        }

        this._togglePicker();
        this._ensureLibraryLoaded();
      });

      this.viewer.container.appendChild(btn);
      this._launcherBtn = btn;
    }

    // ----------------------------- UI: picker panel -----------------------------
    _createPickerPanel() {
      const panel = document.createElement('div');
      panel.className = 'elin-stamp-picker';
      panel.style.display = 'none';

      panel.innerHTML = `
        <div class="elin-stamp-picker__header">
          <div class="elin-stamp-picker__title">ELIN Stempel-Bibliothek</div>
          <div class="elin-stamp-picker__header-actions">
            <button class="elin-btn" data-action="reload">Neu laden</button>
            <button class="elin-btn elin-btn--ghost" data-action="close">✕</button>
          </div>
        </div>

        <div class="elin-stamp-picker__body">
          <input class="elin-input" type="text" placeholder="Suche (Key/Label) …" data-role="search" />
          <div class="elin-stamp-picker__meta" data-role="meta"></div>
          <div class="elin-stamp-picker__list" data-role="list"></div>
        </div>

        <div class="elin-stamp-picker__footer">
          <div class="elin-stamp-picker__hint">
            <b>Platzieren:</b> Stempel wählen → Klick im Viewer.<br/>
            <b>Move:</b> Drag am Stempel. <b>Scale/Rotation:</b> über Eigenschaften-Panel.<br/>
            <b>Multi-Select:</b> Shift (additiv) / Ctrl (toggle).
          </div>
        </div>
      `;

      panel.addEventListener('click', (ev) => {
        const closeBtn = safeClosest(ev.target, 'button[data-action="close"]');
        const reloadBtn = safeClosest(ev.target, 'button[data-action="reload"]');

        if (closeBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          this._togglePicker(false);
          return;
        }

        if (reloadBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          this._library.loaded = false;
          this._library.error = null;
          this._ensureLibraryLoaded();
        }
      });

      const search = panel.querySelector('[data-role="search"]');
      search.addEventListener('input', () => this._refreshLibraryUI());

      this.viewer.container.appendChild(panel);
      this._pickerPanel = panel;
    }

    _togglePicker(forceOpen) {
      if (!this._pickerPanel) return;
      const open = (typeof forceOpen === 'boolean') ? forceOpen : (this._pickerPanel.style.display === 'none');
      this._pickerPanel.style.display = open ? 'flex' : 'none';

      if (open) {
        const input = this._pickerPanel.querySelector('[data-role="search"]');
        if (input) input.focus();
        this._refreshLibraryUI();
      }
    }

    _refreshLibraryUI(statusText) {
      if (!this._pickerPanel) return;

      const meta = this._pickerPanel.querySelector('[data-role="meta"]');
      const listEl = this._pickerPanel.querySelector('[data-role="list"]');
      const q = ((this._pickerPanel.querySelector('[data-role="search"]') || {}).value || '').trim();

      listEl.innerHTML = '';

      if (statusText) {
        meta.textContent = statusText;
        return;
      }

      if (!this._library.loaded) {
        meta.textContent = this._library.error ? `Fehler: ${this._library.error.message}` : 'Lade stamps.json …';
        return;
      }

      const results = this._library.search(q, 160);
      meta.textContent = `${results.length} Treffer${q ? ` für „${q}“` : ''}`;

      for (const def of results) {
        const row = document.createElement('button');
        row.className = 'elin-stamp-item';
        row.type = 'button';
        row.dataset.key = def.key;
        if (def.key === this._activeStampKey) row.classList.add('is-active');

        row.innerHTML = `
          <span class="elin-stamp-item__preview">
            <svg viewBox="${def.viewBox}" xmlns="http://www.w3.org/2000/svg">${def.svg}</svg>
          </span>
          <span class="elin-stamp-item__text">
            <span class="elin-stamp-item__key">${def.key}</span>
            <span class="elin-stamp-item__label">${def.label || ''}</span>
          </span>
          <span class="elin-stamp-item__action">Platzieren</span>
        `;

        row.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();

          this._activeStampKey = def.key;
          this._setPlacingMode(true);
          this._togglePicker(false);
        });

        listEl.appendChild(row);
      }

      if (results.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'elin-stamp-picker__empty';
        empty.textContent = 'Keine Stempel gefunden.';
        listEl.appendChild(empty);
      }
    }

    _setPlacingMode(on) {
      this._placing = !!on;
      if (this.viewer && this.viewer.canvas) {
        this.viewer.canvas.style.cursor = this._placing ? 'crosshair' : 'default';
      }
      if (this._launcherBtn) {
        this._launcherBtn.classList.toggle('is-placing', this._placing);
        this._launcherBtn.title = this._placing ? 'Platzierungsmodus abbrechen' : 'Stempel-Bibliothek öffnen';
      }
    }

    _onEscapeKey(ev) {
      if (ev.key === 'Escape' && this._placing) {
        this._setPlacingMode(false);
        this._activeStampKey = null;
      }
    }

    _setMultiSelectMode(on) {
      this._multiSelectMode = !!on;
      if (!this._propsPanel) return;

      const btn = this._propsPanel.querySelector('[data-action="multiselect"]');
      if (!btn) return;

      btn.classList.toggle('is-active', this._multiSelectMode);
      btn.setAttribute('aria-pressed', String(this._multiSelectMode));
      btn.textContent = this._multiSelectMode ? 'Mehrfachauswahl: An' : 'Mehrfachauswahl';
    }

    // ----------------------------- UI: properties panel -----------------------------
    _createPropertiesPanel() {
      const panel = document.createElement('div');
      panel.className = 'elin-properties-panel';
      panel.style.display = 'flex';

      panel.innerHTML = `
        <div class="elin-properties-panel__header" data-role="paneldrag">
          <div class="elin-properties-panel__title">ELIN Prüfung</div>
          <button class="elin-btn elin-btn--toggle" type="button" data-action="multiselect" aria-pressed="false">Mehrfachauswahl</button>
          <button class="elin-btn elin-btn--ghost elin-panel-collapse-btn" type="button" data-action="collapse" title="Einklappen" aria-expanded="true">–</button>
        </div>
        <div class="elin-properties-panel__content">

        <div class="elin-properties-panel__row">
          <div class="elin-properties-panel__label">Selektiert</div>
          <div class="elin-properties-panel__value" data-role="selcount">0</div>
        </div>

        <div class="elin-properties-panel__row">
          <div class="elin-properties-panel__label">ACC Typ</div>
          <select class="elin-select" data-role="issuetype"></select>
        </div>

        <div class="elin-properties-panel__row">
          <div class="elin-properties-panel__label">Status-Farbe</div>
          <select class="elin-select" data-role="stampcolor">
            <option value="#00B050">OK</option>
            <option value="#C00000" selected>Korrektur</option>
            <option value="#FFC000">Aufpassen</option>
            <option value="#000000">Zurück</option>
          </select>
        </div>

        <div class="elin-properties-panel__row">
          <div class="elin-properties-panel__label">Text</div>
          <input class="elin-input" type="text" placeholder="Optionaler Text..." data-role="stamptext" />
        </div>

        <div class="elin-properties-panel__row">
          <div class="elin-properties-panel__label">Skalierung</div>
          <input class="elin-range" type="range" min="0.25" max="6" step="0.05" value="1" data-role="scale" />
        </div>

        <div class="elin-properties-panel__row">
          <div class="elin-properties-panel__label">Liniendicke</div>
          <input class="elin-range" type="range" min="1" max="50" step="1" value="15" data-role="strokewidth" />
        </div>

        <div class="elin-properties-panel__row">
          <div class="elin-properties-panel__label">Rotation</div>
          <input class="elin-range" type="range" min="0" max="360" step="1" value="0" data-role="rotation" />
        </div>

        <div class="elin-properties-panel__actions">
          <button class="elin-btn" data-action="acc">In ACC Aufgabe umwandeln</button>
          <button class="elin-btn elin-btn--danger" data-action="del">Löschen</button>
        </div>
        </div>
      `;

      panel.addEventListener('click', (ev) => {
        const accBtn = safeClosest(ev.target, 'button[data-action="acc"]');
        const delBtn = safeClosest(ev.target, 'button[data-action="del"]');
        const multiBtn = safeClosest(ev.target, 'button[data-action="multiselect"]');
        const collapseBtn = safeClosest(ev.target, 'button[data-action="collapse"]');

        if (collapseBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          const isCollapsed = panel.classList.toggle('is-collapsed');
          collapseBtn.textContent = isCollapsed ? '+' : '–';
          collapseBtn.setAttribute('aria-expanded', String(!isCollapsed));
          collapseBtn.title = isCollapsed ? 'Ausklappen' : 'Einklappen';
          return;
        }

        if (multiBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          this._setMultiSelectMode(!this._multiSelectMode);
          return;
        }

        if (accBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          this._sendSelectedToAcc().catch((e) => {
            console.error(e);
            alert('ACC Fehler: ' + e.message);
          });
          return;
        }

        if (delBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          this._deleteSelectedStamps();
        }
      });

      const dragHandle = panel.querySelector('[data-role="paneldrag"]');
      dragHandle.addEventListener('pointerdown', (ev) => {
        if (safeClosest(ev.target, 'button, input, select, textarea')) return;
        ev.preventDefault();
        ev.stopPropagation();

        const startLeft = panel.offsetLeft;
        const startTop = panel.offsetTop;
        panel.style.left = startLeft + 'px';
        panel.style.top = startTop + 'px';
        panel.style.right = 'auto';

        this._panelDragState = {
          startClientX: ev.clientX,
          startClientY: ev.clientY,
          startLeft: startLeft,
          startTop: startTop
        };

        const onMove = (mv) => {
          if (!this._panelDragState) return;
          const dx = mv.clientX - this._panelDragState.startClientX;
          const dy = mv.clientY - this._panelDragState.startClientY;
          const nextLeft = clamp(this._panelDragState.startLeft + dx, 8, Math.max(8, window.innerWidth - panel.offsetWidth - 8));
          const nextTop = clamp(this._panelDragState.startTop + dy, 8, Math.max(8, window.innerHeight - panel.offsetHeight - 8));
          panel.style.left = `${nextLeft}px`;
          panel.style.top = `${nextTop}px`;
        };

        const onUp = () => {
          this._panelDragState = null;
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
        };

        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
      }, true);

      const issueTypeSel = panel.querySelector('[data-role="issuetype"]');
      issueTypeSel.innerHTML = '<option value="">Lade aktive ACC Subtypes ...</option>';
      issueTypeSel.addEventListener('change', () => {
        const v = issueTypeSel.value;
        if (!v) return;
        this._defaultIssueSubtypeId = v;
        for (const s of this._selected) s.issueSubtypeId = v;
        this._saveStampsToServer();
      });

      const colorSel = panel.querySelector('[data-role="stampcolor"]');
      colorSel.addEventListener('change', () => {
        const v = colorSel.value || DEFAULT_STAMP_COLOR;
        for (const s of this._selected) {
          s.color = v;
          this._refreshStampHtml(s);
          this._updateStampTextDom(s);
        }
        this._saveStampsToServer();
      });

      const textInput = panel.querySelector('[data-role="stamptext"]');
      textInput.addEventListener('input', () => {
        const v = String(textInput.value || '');
        for (const s of this._selected) {
          s.text = v;
          this._updateStampTextDom(s);
        }
        this._saveStampsToServer();
      });

      const scaleRange = panel.querySelector('[data-role="scale"]');
      scaleRange.addEventListener('input', () => {
        const v = clamp(parseFloat(scaleRange.value), this._minScale, this._maxScale);
        for (const s of this._selected) {
          s.scale = v;
          this._updateStampDom(s);
        }
      });
      scaleRange.addEventListener('change', () => {
        const v = clamp(parseFloat(scaleRange.value), this._minScale, this._maxScale);
        for (const s of this._selected) {
          s.scale = v;
          this._updateStampDom(s);
        }
        this._saveStampsToServer();
      });

      const strokeWidthRange = panel.querySelector('[data-role="strokewidth"]');
      strokeWidthRange.addEventListener('input', () => {
        const raw = Number(strokeWidthRange.value);
        const v = clamp(raw, 1, 50);
        for (const s of this._selected) {
          s.strokeWidth = v;
          this._refreshStampHtml(s);
          this._updateStampTextDom(s);
        }
      });
      strokeWidthRange.addEventListener('change', () => {
        const raw = Number(strokeWidthRange.value);
        const v = clamp(raw, 1, 50);
        for (const s of this._selected) {
          s.strokeWidth = v;
          this._refreshStampHtml(s);
          this._updateStampTextDom(s);
        }
        this._saveStampsToServer();
      });

      const rotationRange = panel.querySelector('[data-role="rotation"]');
      rotationRange.addEventListener('input', () => {
        const raw = clamp(Number(rotationRange.value), 0, 360);
        const snapPoints = [0, 90, 180, 270, 360];
        const snapTolerance = 5;
        let snapped = raw;
        for (const p of snapPoints) {
          if (Math.abs(raw - p) <= snapTolerance) {
            snapped = p;
            break;
          }
        }
        rotationRange.value = String(snapped);
        for (const s of this._selected) {
          s.rotation = snapped;
          this._updateStampDom(s);
        }
      });
      rotationRange.addEventListener('change', () => {
        const raw = clamp(Number(rotationRange.value), 0, 360);
        const snapPoints = [0, 90, 180, 270, 360];
        const snapTolerance = 5;
        let snapped = raw;
        for (const p of snapPoints) {
          if (Math.abs(raw - p) <= snapTolerance) {
            snapped = p;
            break;
          }
        }
        rotationRange.value = String(snapped);
        for (const s of this._selected) {
          s.rotation = snapped;
          this._updateStampDom(s);
        }
        this._saveStampsToServer();
      });

      this.viewer.container.appendChild(panel);
      this._propsPanel = panel;
      this._setMultiSelectMode(false);
      this._updatePropertiesPanel();
    }

    _updatePropertiesPanel() {
      if (!this._propsPanel) return;

      if (!this._issueSubtypeOptions || this._issueSubtypeOptions.length === 0) {
        this._loadIssueSubtypeOptions();
      }

      this._propsPanel.style.display = 'flex';
      this._propsPanel.querySelector('[data-role="selcount"]').textContent = String(this._selected.length);

      const accBtn = this._propsPanel.querySelector('button[data-action="acc"]');
      const delBtn = this._propsPanel.querySelector('button[data-action="del"]');
      const hasSelection = this._selected.length > 0;
      if (accBtn) accBtn.disabled = !hasSelection;
      if (delBtn) delBtn.disabled = !hasSelection;

      if (!hasSelection) {
        const issueSel = this._propsPanel.querySelector('[data-role="issuetype"]');
        const colorSel = this._propsPanel.querySelector('[data-role="stampcolor"]');
        const textInput = this._propsPanel.querySelector('[data-role="stamptext"]');
        issueSel.value = this._defaultIssueSubtypeId || '';
        colorSel.value = DEFAULT_STAMP_COLOR;
        textInput.value = '';
        this._propsPanel.querySelector('[data-role="scale"]').value = '1';
        this._propsPanel.querySelector('[data-role="strokewidth"]').value = String(DEFAULT_STROKE_WIDTH);
        this._propsPanel.querySelector('[data-role="rotation"]').value = '0';
        return;
      }

      const types = new Set(this._selected.map((s) => s.issueSubtypeId || this._defaultIssueSubtypeId || ''));
      const issueSel = this._propsPanel.querySelector('[data-role="issuetype"]');
      if (types.size === 1) issueSel.value = Array.from(types)[0];
      else issueSel.value = this._defaultIssueSubtypeId || '';

      const colorSel = this._propsPanel.querySelector('[data-role="stampcolor"]');
      const colors = new Set(this._selected.map((s) => (s.color || DEFAULT_STAMP_COLOR)));
      if (colors.size === 1) colorSel.value = Array.from(colors)[0];
      else colorSel.value = DEFAULT_STAMP_COLOR;

      const textInput = this._propsPanel.querySelector('[data-role="stamptext"]');
      const texts = new Set(this._selected.map((s) => String(s.text || '')));
      textInput.value = texts.size === 1 ? Array.from(texts)[0] : '';

      const scales = this._selected.map((s) => (typeof s.scale === 'number' ? s.scale : 1));
      const avg = scales.reduce((a, b) => a + b, 0) / Math.max(1, scales.length);
      this._propsPanel.querySelector('[data-role="scale"]').value = String(clamp(avg, this._minScale, this._maxScale));

      const strokeWidths = this._selected.map((s) => (typeof s.strokeWidth === 'number' ? s.strokeWidth : DEFAULT_STROKE_WIDTH));
      const avgStroke = strokeWidths.reduce((a, b) => a + b, 0) / Math.max(1, strokeWidths.length);
      this._propsPanel.querySelector('[data-role="strokewidth"]').value = String(clamp(avgStroke, 1, 50));

      const rotations = this._selected.map((s) => (typeof s.rotation === 'number' ? s.rotation : 0));
      const avgRot = rotations.reduce((a, b) => a + b, 0) / Math.max(1, rotations.length);
      const normalizedRot = ((avgRot % 360) + 360) % 360;
      this._propsPanel.querySelector('[data-role="rotation"]').value = String(Math.round(normalizedRot));
    }

    // ----------------------------- Model/view lifecycle -----------------------------
    async _onModelRootLoaded() {
      this._clearAllStampsDom();
      this._clearSelection();
      await this._loadStampsFromServer();
      this._loadIssueSubtypeOptions();
      this._updateAllStamps();
      this._ensureLibraryLoaded();
    }

    _resolveProjectId() {
      const treeCtx = (window.ELIN_TREE_CTX && typeof window.ELIN_TREE_CTX === 'object') ? window.ELIN_TREE_CTX : {};
      const fromTree = treeCtx.projectId ? String(treeCtx.projectId).trim() : '';
      if (fromTree) return fromTree;

      const fromUrl = (() => {
        try {
          const path = `${window.location.pathname || ''}${window.location.search || ''}${window.location.hash || ''}`;
          const m = path.match(/projects\/(b\.[0-9a-f-]{8,})/i);
          if (m && m[1]) return m[1];

          const query = new URLSearchParams(window.location.search || '');
          return query.get('projectId') || query.get('bimProjectId') || '';
        } catch (e) {
          return '';
        }
      })();
      if (fromUrl) return fromUrl;

      const model = this.viewer && this.viewer.model;
      const docNode = model && model.getDocumentNode ? model.getDocumentNode() : null;
      const rawConfig = docNode && docNode.getRawConfig ? docNode.getRawConfig() : null;
      const seedUrn = rawConfig && rawConfig.seedURN ? String(rawConfig.seedURN) : '';
      const data = model && model.getData ? model.getData() : null;
      const fromModelCandidates = [
        data && data.projectId,
        data && data.loadOptions && data.loadOptions.projectId,
        data && data.metadata && data.metadata.projectId,
        model && model.myData && model.myData.projectId,
        model && model.myData && model.myData.loadOptions && model.myData.loadOptions.projectId,
        rawConfig && rawConfig.projectId,
        rawConfig && rawConfig.project,
        rawConfig && rawConfig['x-ads-project-id']
      ];

      for (const candidate of fromModelCandidates) {
        const value = candidate ? String(candidate).trim() : '';
        if (value) return value;
      }

      if (seedUrn) {
        const seedMatch = seedUrn.match(/projects\/(b\.[0-9a-f-]{8,})/i);
        if (seedMatch && seedMatch[1]) return seedMatch[1];
      }

      return null;
    }

    _resolveHubId() {
      const treeCtx = (window.ELIN_TREE_CTX && typeof window.ELIN_TREE_CTX === 'object') ? window.ELIN_TREE_CTX : {};
      const fromTree = treeCtx.hubId ? String(treeCtx.hubId).trim() : '';
      if (fromTree) return fromTree;

      const fromUrl = (() => {
        try {
          const path = `${window.location.pathname || ''}${window.location.search || ''}${window.location.hash || ''}`;
          const m = path.match(/hubs\/(b\.[0-9a-f-]{8,})/i);
          if (m && m[1]) return m[1];
          const query = new URLSearchParams(window.location.search || '');
          return query.get('hubId') || query.get('bimHubId') || '';
        } catch (e) {
          return '';
        }
      })();
      if (fromUrl) return fromUrl;

      const model = this.viewer && this.viewer.model;
      const data = model && model.getData ? model.getData() : null;
      const candidates = [
        data && data.hubId,
        data && data.loadOptions && data.loadOptions.hubId,
        data && data.metadata && data.metadata.hubId,
        model && model.myData && model.myData.hubId,
        model && model.myData && model.myData.loadOptions && model.myData.loadOptions.hubId
      ];
      for (const candidate of candidates) {
        const value = candidate ? String(candidate).trim() : '';
        if (value) return value;
      }
      return null;
    }

    async _loadIssueSubtypeOptions() {
      try {
        const ctx = (window.ELIN_TREE_CTX && typeof window.ELIN_TREE_CTX === 'object') ? window.ELIN_TREE_CTX : {};
        const hubId = ctx.hubId ? String(ctx.hubId).trim() : '';
        const projectId = ctx.projectId ? String(ctx.projectId).trim() : '';
        if (!hubId || !projectId) return;

        let out = null;
        const primaryUrl = `/api/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}/issuetypes`;
        const fallbackUrl = `/api/issues/types?projectId=${encodeURIComponent(projectId)}`;

        let res = await fetch(primaryUrl, { cache: 'no-store' });
        if (!res.ok) {
          console.warn('[ELIN] Hub/Projekt-Issue-Types Endpoint fehlgeschlagen, versuche Fallback.', {
            url: primaryUrl,
            status: res.status,
            statusText: res.statusText
          });
          res = await fetch(fallbackUrl, { cache: 'no-store' });
        }

        if (!res.ok) {
          console.warn('[ELIN] Issue-Subtypes konnten nicht geladen werden.', {
            primaryUrl,
            fallbackUrl,
            status: res.status,
            statusText: res.statusText
          });
          if (this._propsPanel) {
            const sel = this._propsPanel.querySelector('[data-role="issuetype"]');
            if (sel) sel.innerHTML = '<option value="">ACC Subtypes konnten nicht geladen werden</option>';
          }
          return;
        }

        out = await res.json();
        if (!out || !Array.isArray(out.options) || out.options.length === 0) return;

        this._issueSubtypeOptions = out.options
          .filter((o) => o && o.value)
          .map((o) => ({
            value: String(o.value),
            label: String(o.label || o.title || o.value)
          }));

        const suggestedDefault = out && out.defaultSubtypeId ? String(out.defaultSubtypeId) : '';
        const hasSuggestedDefault = suggestedDefault && this._issueSubtypeOptions.some((o) => o.value === suggestedDefault);

        if (hasSuggestedDefault) {
          this._defaultIssueSubtypeId = suggestedDefault;
        } else if (!this._defaultIssueSubtypeId || !this._issueSubtypeOptions.some((o) => o.value === this._defaultIssueSubtypeId)) {
          this._defaultIssueSubtypeId = this._issueSubtypeOptions[0].value;
        }

        if (this._propsPanel) {
          const sel = this._propsPanel.querySelector('[data-role="issuetype"]');
          if (sel) {
            sel.innerHTML = this._issueSubtypeOptions
              .map((o) => `<option value="${o.value}">${o.label}</option>`)
              .join('');
            sel.value = this._defaultIssueSubtypeId || this._issueSubtypeOptions[0].value;
          }
        }

        for (const stamp of this._stamps) {
          if (!stamp.issueSubtypeId) {
            stamp.issueSubtypeId = this._defaultIssueSubtypeId;
          }
        }
      } catch (e) {
        console.warn('[ELIN] Issue-Subtypes konnten nicht geladen werden:', e);
      }
    }

    _currentStorageKey(useNormalized = true) {
      const model = this.viewer.model;
      if (!model) return null;

      // Robuste URN-Ermittlung (siehe _sendSelectedToAcc)
      let urn = null;
      if (model.getSeedUrn && typeof model.getSeedUrn === 'function') {
        urn = model.getSeedUrn();
      }
      if (!urn && model.myData && model.myData.urn) {
        urn = model.myData.urn;
      }
      if (!urn && model.loader && model.loader.svfUrn) {
        urn = model.loader.svfUrn;
      }
      urn = useNormalized ? normalizeStorageUrn(urn || 'unknownUrn') : String(urn || 'unknownUrn');

      const docNode = model.getDocumentNode && model.getDocumentNode();
      const guid = (docNode && docNode.data && docNode.data.guid) ? docNode.data.guid : 'unknownView';
      return `elin_${urn}_${guid}`;
    }

    async _saveStampsToServer() {
      const key = this._currentStorageKey();
        if (!key) return; // Ensure we have a valid key before proceeding

      const payload = this._stamps.map((s) => ({
        id: s.id,
        stampKey: s.stampKey,
        color: s.color || null,
        text: s.text || '',
        textOffset: {
          x: Number(s.textOffset && s.textOffset.x) || 0,
          y: Number(s.textOffset && s.textOffset.y) || 0
        },
        worldPos: vecToPlain(s.worldPos),
        dbWorld: vecToPlain(s.dbWorld || s.worldPos),
        scale: (typeof s.scale === 'number' ? s.scale : 1),
        strokeWidth: (typeof s.strokeWidth === 'number' ? s.strokeWidth : DEFAULT_STROKE_WIDTH),
        rotation: (typeof s.rotation === 'number' ? s.rotation : 0),
        issueType: s.issueType || 'allgemein',
        issueSubtypeId: s.issueSubtypeId || null,
        referenceZoom: s.referenceZoom || 1  // Für absolute Skalierung
      }));

      try {
        const res = await fetch('/api/stamps/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, stamps: payload })
        });
        if (!res.ok) {
          const txt = await res.text();
          console.warn('ELIN: Could not save stamps to server', res.status, txt);
        }
      } catch (e) {
        console.warn('ELIN: Could not save stamps to server', e);
      }
    }

    async _loadStampsFromServer() {
      let normalizedKey = this._currentStorageKey(true);
      let legacyKey = this._currentStorageKey(false);

      // On some model lifecycle timings, URN/guid arrive slightly after MODEL_ROOT_LOADED.
      for (let i = 0; i < 8; i += 1) {
        const invalidNormalized = !normalizedKey || normalizedKey.includes('unknownView') || normalizedKey.includes('unknownUrn');
        const invalidLegacy = !legacyKey || legacyKey.includes('unknownView') || legacyKey.includes('unknownUrn');
        if (!invalidNormalized || !invalidLegacy) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
        normalizedKey = this._currentStorageKey(true);
        legacyKey = this._currentStorageKey(false);
      }

      const keyCandidates = Array.from(new Set([normalizedKey, legacyKey].filter(Boolean)));
      if (keyCandidates.length === 0) return;

      try {
        let arr = [];
        for (const key of keyCandidates) {
          const res = await fetch(`/api/stamps/load?key=${encodeURIComponent(key)}`, { cache: 'no-store' });
          if (!res.ok) {
            const txt = await res.text();
            console.warn('ELIN: Could not load stamps from server', res.status, txt, { key });
            continue;
          }

          const out = await res.json();
          arr = out && Array.isArray(out.stamps) ? out.stamps : [];
          if (arr.length > 0) {
            // Migrate legacy key to normalized key in-place for future loads.
            if (key !== normalizedKey && normalizedKey) {
              await fetch('/api/stamps/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: normalizedKey, stamps: arr })
              });
            }
            break;
          }
        }

        if (!Array.isArray(arr)) return;

        for (const d of arr) {
          if (!d || !d.stampKey) continue;
          this._createStampInstance({
            id: d.id || uid(),
            stampKey: d.stampKey,
            color: d.color || null,
            text: d.text || '',
            textOffset: d.textOffset || { x: 0, y: 0 },
            worldPos: plainToVec3(d.worldPos),
            dbWorld: plainToVec3(d.dbWorld || d.worldPos),
            scale: (typeof d.scale === 'number' ? d.scale : 1),
            strokeWidth: d.strokeWidth || 15,
            rotation: (typeof d.rotation === 'number' ? d.rotation : 0),
            issueType: d.issueType || 'allgemein',
            issueSubtypeId: d.issueSubtypeId || null,
            referenceZoom: d.referenceZoom || this._getCurrentZoomFactor()  // Fallback zum aktuellen Zoom
          }, false);
        }
      } catch (e) {
        console.warn('ELIN: Could not load/parse saved stamps from server', e);
      }
    }

    _clearAllStampsDom() {
      for (const s of this._stamps) {
        if (s.el) s.el.remove();
      }
      this._stamps = [];
    }

    // ----------------------------- Pointer / Keyboard handling -----------------------------
    _handleKeyDown(ev) {
      if (ev.key === 'Escape') {
        this._setPlacingMode(false);
        if (this._pickerPanel && this._pickerPanel.style.display !== 'none') this._togglePicker(false);
      }

      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (this._selected.length > 0) {
          ev.preventDefault();
          ev.stopPropagation();
          this._deleteSelectedStamps();
        }
      }
    }

    _handleContainerPointerDownCapture(ev) {
      // ignore clicks inside our UI
      if (safeClosest(ev.target, '.elin-stamp-picker') ||
          safeClosest(ev.target, '.elin-properties-panel') ||
          safeClosest(ev.target, '.elin-launcher-btn')) {
        return;
      }

      // Placing mode: left click on canvas creates a stamp
      if (this._placing && ev.button === 0) {
        const pt = this._eventToWorldPoint(ev, null);
        if (!pt) return;

        if (!this._activeStampKey) {
          alert('Bitte zuerst einen Stempel auswählen.');
          return;
        }

        this._createStampInstance({
          id: uid(),
          stampKey: this._activeStampKey,
          worldPos: pt,
          scale: 1,
          issueType: this._defaultIssueType
        }, true);

        this._ignoreNextContainerClick = true;
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }

      // Click on empty area clears selection (unless drag just started on a stamp)
      if (!safeClosest(ev.target, '.elin-stamp') && !this._ignoreNextContainerClick) {
        this._clearSelection();
      }
    }

    _eventToCanvasXY(ev) {
      const rect = this.viewer.canvas.getBoundingClientRect();
      return {
        x: ev.clientX - rect.left,
        y: ev.clientY - rect.top
      };
    }

    _eventToWorldPoint(ev, fallbackPlanePoint) {
      const ptCanvas = this._eventToCanvasXY(ev);
      const x = ptCanvas.x;
      const y = ptCanvas.y;

      // 1) clientToWorld (works well in 2D and on 3D geometry)
      try {
        const res = this.viewer.clientToWorld(x, y, true);
        const p = res ? (res.point || res.intersectPoint || res) : null;
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          return new THREE.Vector3(p.x, p.y, Number.isFinite(p.z) ? p.z : 0);
        }
      } catch (e) {
        // ignore
      }

      // 2) 3D fallback: ray-plane through original point
      if (!fallbackPlanePoint) return null;

      try {
        const canvas = this.viewer.canvas;
        const ndc = {
          x: (x / canvas.clientWidth) * 2 - 1,
          y: -((y / canvas.clientHeight) * 2 - 1)
        };

        const cam = this.viewer.impl.camera;
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, cam);

        const n = new THREE.Vector3();
        cam.getWorldDirection(n);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, fallbackPlanePoint);

        const hit = new THREE.Vector3();
        const ok = raycaster.ray.intersectPlane(plane, hit);
        if (ok) return hit;
      } catch (e) {
        // ignore
      }

      return null;
    }

    // ----------------------------- Stamp creation / DOM -----------------------------
    _createStampInstance(data, save) {
      const def = this._library.get(data.stampKey);

      const stamp = {
        id: data.id || uid(),
        stampKey: data.stampKey,
        label: def ? (def.label || '') : '',
        worldPos: data.worldPos instanceof THREE.Vector3 ? data.worldPos.clone() : plainToVec3(data.worldPos),
        dbWorld: data.dbWorld instanceof THREE.Vector3
          ? data.dbWorld.clone()
          : (data.worldPos instanceof THREE.Vector3 ? data.worldPos.clone() : plainToVec3(data.worldPos)),
        scale: (typeof data.scale === 'number' ? data.scale : 1),
        strokeWidth: data.strokeWidth || 15,
        rotation: (typeof data.rotation === 'number' ? data.rotation : 0),
        color: data.color || null,
        text: data.text || '',
        textOffset: {
          x: Number(data.textOffset && data.textOffset.x) || 0,
          y: Number(data.textOffset && data.textOffset.y) || 0
        },
        issueType: data.issueType || 'allgemein',
        issueSubtypeId: data.issueSubtypeId || null,
        referenceZoom: data.referenceZoom || this._getCurrentZoomFactor(), // Zoom beim Erstellen
        el: null
      };

      stamp.el = this._buildStampElement(stamp, def);
      this.viewer.container.appendChild(stamp.el);
      this._stamps.push(stamp);

      this._updateStampDom(stamp);
      this._updateStampTextDom(stamp);

      if (save) this._saveStampsToServer();
      return stamp;
    }

    _buildStampElement(stamp, def) {
      const root = document.createElement('div');
      root.className = 'elin-stamp';
      root.dataset.id = stamp.id;

      root.innerHTML = `
        <div class="elin-stamp__body">${this._getStampBodySvgHtml(def, stamp.color, stamp.strokeWidth)}</div>
        <div class="elin-stamp__custom-text"></div>
      `;

      // selection + move
      root.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;

        const isTextEl = ev.target && ev.target.closest && ev.target.closest('.elin-stamp__custom-text');
        if (isTextEl) {
          ev.stopPropagation();
          ev.preventDefault();

          const additive = !!ev.shiftKey;
          const toggle = !!ev.ctrlKey || !!ev.metaKey;
          if (this._multiSelectMode) {
            this._toggleSelection(stamp);
            return;
          }
          if (toggle) this._toggleSelection(stamp);
          else this._selectStamp(stamp, additive);

          this._dragState = {
            mode: 'move-text',
            target: stamp,
            startClient: { x: ev.clientX, y: ev.clientY },
            startOffset: {
              x: Number(stamp.textOffset && stamp.textOffset.x) || 0,
              y: Number(stamp.textOffset && stamp.textOffset.y) || 0
            }
          };

          this._ignoreNextContainerClick = true;
          try { root.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }

          const onMove = (mv) => this._onStampPointerMove(mv);
          const onUp = (up) => {
            this._onStampPointerUp(up);
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
          };

          window.addEventListener('pointermove', onMove, true);
          window.addEventListener('pointerup', onUp, true);
          return;
        }

        ev.stopPropagation();
        ev.preventDefault();

        const additive = !!ev.shiftKey;
        const toggle = !!ev.ctrlKey || !!ev.metaKey;

        // In multi-select mode: if stamp is already part of the selection,
        // keep the group intact and start a group-move instead of toggling.
        if (this._multiSelectMode && this._selected.includes(stamp) && this._selected.length > 1) {
          // fall through to group-move below without changing selection
        } else if (this._multiSelectMode) {
          this._toggleSelection(stamp);
          return;
        } else if (toggle) {
          this._toggleSelection(stamp);
        } else {
          this._selectStamp(stamp, additive);
        }

        // Move single or multi-selected group
        const targets = (this._selected.includes(stamp) && this._selected.length > 0)
          ? this._selected.slice()
          : [stamp];

        const startWorldById = new Map();
        for (const s of targets) startWorldById.set(s.id, s.worldPos.clone());

        this._dragState = {
          mode: 'move',
          anchorStamp: stamp,
          targets,
          startWorldById,
          anchorStartWorld: stamp.worldPos.clone()
        };

        this._ignoreNextContainerClick = true;
        try { root.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }

        const onMove = (mv) => this._onStampPointerMove(mv);
        const onUp = (up) => {
          this._onStampPointerUp(up);
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
        };

        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
      }, true);

      return root;
    }

    _updateStampTextDom(stamp) {
      if (!stamp || !stamp.el) return;
      const textEl = stamp.el.querySelector('.elin-stamp__custom-text');
      if (!textEl) return;
      const text = stamp.text || '';
      const textOffsetX = Number(stamp.textOffset && stamp.textOffset.x) || 0;
      const textOffsetY = Number(stamp.textOffset && stamp.textOffset.y) || 0;
      const textBorderWidth = Math.max(1, Math.min(3, (stamp.strokeWidth || 15) * 0.1));
      textEl.textContent = text;
      textEl.style.display = text ? 'block' : 'none';
      textEl.style.color = stamp.color || DEFAULT_STAMP_COLOR;
      textEl.style.border = `${textBorderWidth}px solid ${stamp.color || DEFAULT_STAMP_COLOR}`;
      textEl.style.background = 'rgba(255, 255, 255, 0.85)';
      textEl.style.padding = '1px 2px';
      textEl.style.transform = `translate(calc(-50% + ${textOffsetX}px), ${textOffsetY}px)`;
    }

    _onStampPointerMove(ev) {
      if (!this._dragState) return;

      const st = this._dragState;

      if (st.mode === 'move-text') {
        const currentZoom = this._getCurrentZoomFactor();
        const zoomRatio = currentZoom / (st.target.referenceZoom || 1);
        const finalScale = (st.target.scale || 1) * zoomRatio;

        const dx = ev.clientX - st.startClient.x;
        const dy = ev.clientY - st.startClient.y;

        const safeScale = (finalScale && Number.isFinite(finalScale) && Math.abs(finalScale) > 1e-6) ? finalScale : 1;
        st.target.textOffset.x = st.startOffset.x + (dx / safeScale);
        st.target.textOffset.y = st.startOffset.y + (dy / safeScale);

        this._updateStampTextDom(st.target);
        return;
      } else if (st.mode === 'move') {
        const world = this._eventToWorldPoint(ev, st.anchorStartWorld);
        if (!world) return;

        const delta = new THREE.Vector3().subVectors(world, st.anchorStartWorld);

        for (const s of st.targets) {
          const startWorld = st.startWorldById.get(s.id);
          if (!startWorld) continue;
          s.worldPos.copy(startWorld.clone().add(delta));
          s.dbWorld.copy(s.worldPos);
          this._updateStampDom(s);
        }

        this._updatePropertiesPanel();
        return;
      }

    }

    _onStampPointerUp() {
      if (!this._dragState) return;
      this._dragState = null;
      this._saveStampsToServer();
    }

    _updateStampDom(stamp) {
      if (!stamp || !stamp.el) return;
      const p = this.viewer.worldToClient(stamp.worldPos);
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        stamp.el.style.display = 'none';
        return;
      }

      stamp.el.style.left = `${p.x}px`;
      stamp.el.style.top = `${p.y}px`;

      // ABSOLUTE SKALIERUNG: Stempel skaliert mit dem Plan
      // Je näher man zoomt, desto größer wird der Stempel (proportional zum Weltinhalt)
      const currentZoom = this._getCurrentZoomFactor();
      const referenceZoom = stamp.referenceZoom || 1;
      const zoomRatio = currentZoom / referenceZoom;
      const finalScale = (stamp.scale || 1) * zoomRatio;

      stamp.el.style.transform = `translate(-50%, -50%) scale(${finalScale})`;
      const body = stamp.el.querySelector('.elin-stamp__body');
      if (body) {
        const rot = (typeof stamp.rotation === 'number' ? stamp.rotation : 0);
        body.style.transform = `rotate(${rot}deg)`;
      }
      stamp.el.style.display = 'block';
    }

    _updateAllStamps() {
      for (const s of this._stamps) this._updateStampDom(s);
    }

    // ----------------------------- Selection -----------------------------
    _selectStamp(stamp, additive) {
      if (!additive) this._clearSelection();

      if (!this._selected.includes(stamp)) {
        this._selected.push(stamp);
        if (stamp.el) stamp.el.classList.add('selected');
      }

      this._updatePropertiesPanel();
    }

    _toggleSelection(stamp) {
      const idx = this._selected.indexOf(stamp);
      if (idx >= 0) {
        this._selected.splice(idx, 1);
        if (stamp.el) stamp.el.classList.remove('selected');
      } else {
        this._selected.push(stamp);
        if (stamp.el) stamp.el.classList.add('selected');
      }
      this._updatePropertiesPanel();
    }

    _clearSelection() {
      for (const s of this._selected) {
        if (s.el) s.el.classList.remove('selected');
      }
      this._selected = [];
      this._updatePropertiesPanel();
    }

    // ----------------------------- Delete -----------------------------
    _deleteSelectedStamps() {
      if (this._selected.length === 0) return;

      const toDelete = new Set(this._selected.map((s) => s.id));
      this._stamps = this._stamps.filter((s) => {
        if (!toDelete.has(s.id)) return true;
        if (s.el) s.el.remove();
        return false;
      });

      this._clearSelection();
      this._saveStampsToServer();
    }

    // ----------------------------- ACC sync -----------------------------
    async _sendSelectedToAcc() {
      if (this._selected.length === 0) return;

      const model = this.viewer.model;
      if (!model) throw new Error('Kein Model geladen.');

      // Definiere is2D frueh, damit es in allen folgenden Logs/Abfragen sicher verfuegbar ist.
      const is2D = (model && typeof model.is2d === 'function') ? !!model.is2d() : this._is2DModel();

      console.log('[ELIN] Model Debug:', {
        hasGetSeedUrn: typeof model.getSeedUrn === 'function',
        hasGetDocumentNode: typeof model.getDocumentNode === 'function',
        modelType: model.constructor.name
      });

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalizeCtx = (raw) => {
        const c = (raw && typeof raw === 'object') ? raw : {};
        return {
          hubId: c.hubId ? String(c.hubId).trim() : '',
          projectId: c.projectId ? String(c.projectId).trim() : '',
          itemId: c.itemId ? String(c.itemId).trim() : '',
          versionId: c.versionId ? String(c.versionId).trim() : ''
        };
      };

      let mergedCtx = normalizeCtx(window.ELIN_TREE_CTX);
      const isCtxComplete = (c) => !!(c.hubId && c.projectId && c.itemId && c.versionId);

      if (!isCtxComplete(mergedCtx) && this._lastCompleteTreeCtx) {
        mergedCtx = {
          hubId: mergedCtx.hubId || this._lastCompleteTreeCtx.hubId,
          projectId: mergedCtx.projectId || this._lastCompleteTreeCtx.projectId,
          itemId: mergedCtx.itemId || this._lastCompleteTreeCtx.itemId,
          versionId: mergedCtx.versionId || this._lastCompleteTreeCtx.versionId
        };
      }

      if (!isCtxComplete(mergedCtx)) {
        // Sidebar updates hub/project/item/version in separate UI events; wait briefly for completion.
        for (let i = 0; i < 6; i += 1) {
          await sleep(120);
          let latest = normalizeCtx(window.ELIN_TREE_CTX);
          if (!isCtxComplete(latest) && this._lastCompleteTreeCtx) {
            latest = {
              hubId: latest.hubId || this._lastCompleteTreeCtx.hubId,
              projectId: latest.projectId || this._lastCompleteTreeCtx.projectId,
              itemId: latest.itemId || this._lastCompleteTreeCtx.itemId,
              versionId: latest.versionId || this._lastCompleteTreeCtx.versionId
            };
          }
          mergedCtx = latest;
          if (isCtxComplete(mergedCtx)) break;
        }
      }

      if (isCtxComplete(mergedCtx)) {
        this._lastCompleteTreeCtx = { ...mergedCtx };
      }

      const selectedHubId = mergedCtx.hubId;
      const selectedProjectId = mergedCtx.projectId;
      const ctxItemId = mergedCtx.itemId;
      const ctxVersionId = mergedCtx.versionId;

      const docNode = model.getDocumentNode && model.getDocumentNode();
      const viewableId = (docNode && docNode.data && docNode.data.guid) ? String(docNode.data.guid).trim() : '';
      const viewableName = (docNode && docNode.data && docNode.data.name) ? String(docNode.data.name) : 'ELIN Plan Prüfung';

      const toLineageUrn = (rawItemId) => {
        const raw = String(rawItemId || '').trim();
        if (!raw) return '';
        const idPart = raw.includes(':') ? raw.split(':').pop() : raw;
        return idPart ? `urn:adsk.wipemea:dm.lineage:${idPart}` : '';
      };

      const linkedDocumentUrnFromCtx = toLineageUrn(ctxItemId);
      const versionMatch = String(ctxVersionId || '').match(/[?&]version=(\d+)/i);
      const versionNum = (versionMatch && Number.isFinite(parseInt(versionMatch[1], 10)) && parseInt(versionMatch[1], 10) > 0)
        ? parseInt(versionMatch[1], 10)
        : 1;

      if (!selectedHubId || !selectedProjectId || !ctxItemId || !ctxVersionId || !linkedDocumentUrnFromCtx) {
        throw new Error('Strict Mode: hubId/projectId/itemId/versionId fehlen im Sidebar-Kontext. Bitte im Baum ein konkretes Sheet waehlen.');
      }
      if (!viewableId) {
        throw new Error('Strict Mode: viewId (aktuelles Sheet guid) konnte nicht bestimmt werden.');
      }

      await this._loadIssueSubtypeOptions();
      const activeSubtypeIds = new Set((this._issueSubtypeOptions || []).map((o) => String(o.value)));
      const activeDefaultSubtypeId = this._defaultIssueSubtypeId && activeSubtypeIds.has(String(this._defaultIssueSubtypeId))
        ? String(this._defaultIssueSubtypeId)
        : ((this._issueSubtypeOptions[0] && this._issueSubtypeOptions[0].value) ? String(this._issueSubtypeOptions[0].value) : '');

      if (!activeDefaultSubtypeId) {
        throw new Error('Kein aktiver Issue-Subtype verfuegbar. Bitte ACC-Issue-Typen im Projekt pruefen.');
      }

      console.log('[ELIN] Sending to ACC - Model is 2D:', is2D);
      console.log('[ELIN] ViewableId:', viewableId);
      console.log('[ELIN] ViewableName:', viewableName);
      console.log('[ELIN] projectId:', selectedProjectId);
      console.log('[ELIN] hubId:', selectedHubId);
      console.log('[ELIN] itemId:', ctxItemId);
      console.log('[ELIN] versionId:', ctxVersionId);
      console.log('[ELIN] createdAtVersion (strict from versionId):', versionNum);

      const payload = this._selected.map((s) => {
        const def = this._library.get(s.stampKey);
        const label = def ? (def.label || '') : (s.label || '');

        const type = s.issueType || 'allgemein';
        const status = (type === 'mangel') ? 'open' : 'closed';
        const customText = String(s.text || '').trim();
        const titleSuffix = customText ? ` | Text: ${customText}` : '';

        const dbWorldPosition = vecToPlain(s.dbWorld || s.worldPos);
        const worldPosition = vecToPlain(s.worldPos);

        // 2D: keep sheet coordinates with decimal precision; 3D: send true world xyz.
        const modelData = (this.viewer && this.viewer.model && this.viewer.model.getData)
          ? this.viewer.model.getData()
          : null;
        const metricsUsed = is2D ? this._get2DSheetMetrics() : null;

        if (is2D) {
          console.log(`[ELIN][2D][${s.id}] raw viewer coordinates (dbWorld/world):`, {
            dbWorld: dbWorldPosition,
            world: worldPosition
          });
          try {
            console.log(`[ELIN][2D][${s.id}] model.getData().bbox + metadata START`);
            console.log(JSON.stringify({
              bbox: modelData && modelData.bbox ? modelData.bbox : null,
              metadata: modelData && modelData.metadata ? modelData.metadata : null,
              derivedSheetMetrics: metricsUsed
            }, null, 2));
            console.log(`[ELIN][2D][${s.id}] model.getData().bbox + metadata END`);
          } catch (metaErr) {
            console.warn(`[ELIN][2D][${s.id}] Could not stringify bbox/metadata:`, metaErr && metaErr.message ? metaErr.message : metaErr);
          }
        }

        const accPosition = is2D
          ? this._getAcc2DPosition(s.dbWorld || s.worldPos)
          : dbWorldPosition;
        let accNormalizedPosition = is2D
          ? this._getAcc2DNormalizedPosition(s.dbWorld || s.worldPos)
          : dbWorldPosition;

        if (is2D && this._acc2dInvertY && accNormalizedPosition && Number.isFinite(accNormalizedPosition.y)) {
          const clamp01 = (n) => Math.max(0, Math.min(1, n));
          const yBeforeInvert = clamp01(Number(accNormalizedPosition.y));
          const invertedY = clamp01(1 - yBeforeInvert);
          console.log(`[ELIN][2D][${s.id}] Y inversion formula: 1.0 - y`, {
            yBeforeInvert,
            expression: `1.0 - ${yBeforeInvert}`,
            invertedY
          });
          accNormalizedPosition = {
            x: clamp01(Number(accNormalizedPosition.x)),
            y: Math.round(invertedY * 1000000) / 1000000,
            z: 0
          };

          const metrics = metricsUsed || this._get2DSheetMetrics();
          if (metrics && metrics.valid) {
            accPosition.y = Math.round((accNormalizedPosition.y * metrics.pageHeight) * 1000) / 1000;
          }
        }

        if (is2D) {
          console.log(`[ELIN][2D][${s.id}] final payload coordinates`, {
            accPosition,
            accNormalizedPosition,
            finalXY: {
              x: accPosition && Number.isFinite(accPosition.x) ? accPosition.x : null,
              y: accPosition && Number.isFinite(accPosition.y) ? accPosition.y : null
            }
          });
        }
        
        const linkedType = is2D
          ? (USE_2D_VECTOR_PIN ? 'TwoDVectorPushpin' : 'TwoDRasterPushpin')
          : 'ThreeDVectorPushpin';
        const strokeWidth = (typeof s.strokeWidth === 'number' ? s.strokeWidth : DEFAULT_STROKE_WIDTH);
        const coloredStampSvg = def ? this._applyStampStyle(def.svg, s.color, strokeWidth) : null;
        const coloredAccMarkupSvg = def ? this._applyStampStyle(def.accMarkupSvg || '', s.color, strokeWidth) : '';
        console.log(`[ELIN] Stamp ${s.id}: linkedDocumentType = ${linkedType}, accPosition =`, accPosition);

        return {
          id: s.id,

          // Backend-Mapping (issueSubtypeId)
          type,
          issueSubtypeId: (s.issueSubtypeId && activeSubtypeIds.has(String(s.issueSubtypeId)))
            ? String(s.issueSubtypeId)
            : activeDefaultSubtypeId,
          status,

          // Sichtbarer ACC-Titel + eindeutige Stempel-ID
          title: `ELIN: ${s.stampKey}${label ? ' [' + label + ']' : ''}${titleSuffix}`,
          description: customText ? `StampLabel: ${label || s.stampKey} | Text: ${customText}` : '',

          // Zusätzliche Metadaten (server kann sie verwenden oder ignorieren)
          stampKey: s.stampKey,
          stampLabel: label,
          color: s.color || null,
          text: s.text || '',
          scale: Number(s.scale) || 1,
          is3D: !is2D,
          linkedDocumentType: linkedType,

          // Wichtig für 2D ACC Pushpin
          position: accPosition,      // kompatibel zum bestehenden Backend
          accPosition: accPosition,   // explizit
          accNormalizedPosition,
          worldPosition: worldPosition,
          dbWorld: dbWorldPosition,

          viewId: viewableId,
          viewName: viewableName,
          projectId: selectedProjectId,
          hubId: selectedHubId,
          versionId: ctxVersionId,
          versionUrn: ctxVersionId,
          version: versionNum,
          createdAtVersion: versionNum,
          itemId: ctxItemId,
          containerId: null,
          linkedDocumentUrn: linkedDocumentUrnFromCtx,

          // SVG-Fragment + viewBox fuer Markups API POST.
          stampSvg: coloredStampSvg,
          stampViewBox: def ? def.viewBox : null,
          accMarkupSvg: coloredAccMarkupSvg,
          stampWidth: def ? (def.width || 0) : 0,
          stampHeight: def ? (def.height || 0) : 0
        };
      });

      const requestBody = {
        hubId: selectedHubId,
        projectId: selectedProjectId,
        stamps: payload.map((s) => {
          if (!is2D) return s;
          return {
            ...s,
            linkedDocumentUrn: linkedDocumentUrnFromCtx
          };
        })
      };

      try {
        console.log('[ELIN] /api/issues/create payload START');
        console.log(JSON.stringify(requestBody, null, 2));
        console.log('[ELIN] /api/issues/create payload END');
      } catch (payloadErr) {
        console.warn('[ELIN] Could not stringify /api/issues/create payload:', payloadErr && payloadErr.message ? payloadErr.message : payloadErr);
        console.log('[ELIN] /api/issues/create payload fallback object:', requestBody);
      }

      const res = await fetch('/api/issues/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!res.ok) {
        let msg = res.statusText;
        try {
          const err = await res.json();
          if (err && err.message) msg = err.message;
        } catch (e) { /* ignore */ }
        throw new Error(msg);
      }

      let okMsg = `Erfolgreich: ${this._selected.length} Aufgabe(n) in ACC erstellt.`;
      try {
        const out = await res.json();
        if (out && out.message) okMsg = out.message;
      } catch (e) { /* ignore */ }
      alert(okMsg);
    }

    // ----------------------------- Styles -----------------------------
    _injectStyles() {
      if (document.getElementById('elin-stamp-extension-styles')) {
        this._styleEl = document.getElementById('elin-stamp-extension-styles');
        return;
      }

      const style = document.createElement('style');
      style.id = 'elin-stamp-extension-styles';
      style.textContent = `
        .elin-btn {
          border: 1px solid #c7c7c7;
          background: #ffffff;
          padding: 6px 10px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 12px;
        }
        .elin-btn:hover { background: #f5f5f5; }
        .elin-btn--danger { border-color: #e16b6b; color: #b10000; }
        .elin-btn--danger:hover { background: #fff0f0; }
        .elin-btn--ghost { border: none; background: transparent; font-size: 14px; padding: 4px 8px; }
        .elin-btn--toggle.is-active { border-color: #005eb8; background: #e9f4ff; color: #005eb8; }
        .elin-btn:disabled { opacity: 0.45; cursor: not-allowed; }

        .elin-input {
          width: 100%;
          box-sizing: border-box;
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid #c7c7c7;
          font-size: 12px;
          outline: none;
          background: rgba(255,255,255,0.9);
          color: #000;
        }

        .elin-select {
          width: 100%;
          padding: 6px 10px;
          border-radius: 8px;
          border: 1px solid #c7c7c7;
          font-size: 12px;
          background: rgba(255,255,255,0.9);
          color: #000;
        }

        .elin-range { width: 100%; }

        .elin-launcher-btn {
          position: absolute;
          top: 10px;
          left: 10px;
          z-index: 10002;
          border: 1px solid #c7c7c7;
          background: #ffffff;
          border-radius: 8px;
          padding: 7px 10px;
          font-size: 12px;
          cursor: pointer;
          box-shadow: 0 4px 16px rgba(0,0,0,0.12);
        }
        .elin-launcher-btn:hover { background: #f5f5f5; }
        .elin-launcher-btn.is-placing {
          border-color: #0096ff;
          box-shadow: 0 0 0 3px rgba(0,150,255,0.15), 0 4px 16px rgba(0,0,0,0.12);
        }

        /* Stamp overlay */
        .elin-stamp {
          position: absolute;
          z-index: 1000;
          pointer-events: auto;
          width: ${this._baseSizePx}px;
          height: ${this._baseSizePx}px;
          transform: translate(-50%, -50%) scale(1);
          transform-origin: center center;
          user-select: none;
          touch-action: none;
        }

        .elin-stamp__body {
          width: 100%;
          height: 100%;
          background: transparent;
          border-radius: 0;
          border: none;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: none;
          overflow: hidden;
        }

        .elin-stamp__svg { width: 88%; height: 88%; }

        .elin-stamp__custom-text {
          position: absolute;
          top: 100%;
          left: 50%;
          transform: translateX(-50%);
          margin-top: 2px;
          white-space: nowrap;
          font-size: 12px;
          font-weight: 700;
          pointer-events: auto;
          cursor: grab;
          user-select: none;
          text-shadow: 1px 1px 0 #fff, -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff;
        }

        .elin-stamp__custom-text:active { cursor: grabbing; }

        .elin-stamp.selected .elin-stamp__body {
          outline: none;
          box-shadow: none;
        }

        /* Picker panel */
        .elin-stamp-picker {
          position: absolute;
          top: 48px;
          left: 10px;
          width: 420px;
          max-height: 75%;
          z-index: 10001;
          background: white;
          border: 1px solid #d0d0d0;
          border-radius: 12px;
          box-shadow: 0 8px 30px rgba(0,0,0,0.18);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .elin-stamp-picker__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          padding: 10px 10px;
          border-bottom: 1px solid #eee;
        }
        .elin-stamp-picker__header-actions { display: flex; align-items: center; gap: 6px; }
        .elin-stamp-picker__title { font-weight: 700; font-size: 13px; }
        .elin-stamp-picker__body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
        .elin-stamp-picker__meta { font-size: 11px; color: #666; }
        .elin-stamp-picker__list {
          overflow: auto;
          border: 1px solid #eee;
          border-radius: 10px;
          max-height: 380px;
          background: #fff;
        }
        .elin-stamp-picker__empty {
          padding: 12px;
          font-size: 12px;
          color: #666;
        }

        .elin-stamp-item {
          width: 100%;
          display: grid;
          grid-template-columns: 42px 1fr auto;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          border: none;
          background: white;
          cursor: pointer;
          text-align: left;
          border-bottom: 1px solid #f1f1f1;
        }
        .elin-stamp-item:hover { background: #f7fbff; }
        .elin-stamp-item.is-active { background: #eef7ff; }
        .elin-stamp-item__preview {
          width: 36px;
          height: 36px;
          border: 1px solid #eee;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(255,255,255,0.8);
        }
        .elin-stamp-item__preview svg { width: 85%; height: 85%; }
        .elin-stamp-item__key { font-size: 12px; font-weight: 700; display: block; }
        .elin-stamp-item__label { font-size: 11px; color: #666; display: block; }
        .elin-stamp-item__action {
          font-size: 11px;
          color: #005eb8;
          white-space: nowrap;
          padding-left: 6px;
        }

        .elin-stamp-picker__footer {
          border-top: 1px solid #eee;
          padding: 10px;
          font-size: 11px;
          color: #666;
          background: #fafafa;
          line-height: 1.35;
        }

        /* Properties panel */
        .elin-properties-panel {
          position: absolute;
          top: 10px;
          right: 10px;
          width: min(320px, calc(100vw - 20px));
          z-index: 10001;
          background: rgba(255,255,255,0.96);
          border: 1px solid #d0d0d0;
          border-radius: 12px;
          box-shadow: 0 8px 30px rgba(0,0,0,0.18);
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          touch-action: none;
          max-height: 50vh;
          overflow-y: auto;
        }
        .elin-properties-panel.is-collapsed {
          max-height: none;
          overflow: hidden;
          gap: 0;
          padding-top: 8px;
          padding-bottom: 8px;
        }
        .elin-properties-panel__content {
          display: flex;
          flex-direction: column;
          gap: 10px;
          overflow-y: auto;
        }
        .elin-properties-panel.is-collapsed .elin-properties-panel__content {
          display: none;
        }
        .elin-panel-collapse-btn {
          margin-left: auto;
          min-width: 24px;
          font-size: 14px;
          line-height: 1;
          padding: 0 6px;
        }
        .elin-properties-panel__header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          cursor: grab;
          touch-action: none;
        }
        .elin-properties-panel__header:active { cursor: grabbing; }
        .elin-properties-panel__title { font-weight: 700; font-size: 13px; }
        .elin-properties-panel__row {
          display: grid;
          grid-template-columns: 90px 1fr;
          gap: 10px;
          align-items: center;
        }
        .elin-properties-panel__label { font-size: 11px; color: #666; }
        .elin-properties-panel__value { font-size: 12px; font-weight: 700; }
        .elin-properties-panel__actions { display: flex; gap: 8px; }
        .elin-properties-panel__actions .elin-btn { flex: 1; }

        .adsk-viewing-viewer .screen-mode-mask,
        .adsk-viewing-viewer [class*="loading-mask"],
        .adsk-viewing-viewer .docking-panel-container-solid-color-a,
        .adsk-viewing-viewer .docking-panel-container-solid-color-b {
          background: transparent !important;
          box-shadow: none !important;
        }

        @media (max-width: 1400px) {
          .elin-properties-panel {
            left: 10px;
            right: auto;
            bottom: 10px;
            top: auto;
            width: min(360px, calc(100vw - 20px));
          }

          .elin-launcher-btn {
            top: 64px;
          }
        }
      `;
      document.head.appendChild(style);
      this._styleEl = style;
    }
  }

  Autodesk.Viewing.theExtensionManager.registerExtension('ElinStampExtension', ElinStampExtension);
})();
