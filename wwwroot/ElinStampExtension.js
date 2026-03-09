
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

  // ----------------------------- Stamp definition loader -----------------------------
  class StampLibrary {
    constructor(url) {
      this.url = url;
      this.loaded = false;
      this.error = null;
      this.map = new Map(); // key -> { key, label, viewBox, svg }
      this.list = []; // array of defs sorted by key
    }

    async load() {
      this.loaded = false;
      this.error = null;
      this.map.clear();
      this.list = [];

      try {
        const res = await fetch(this.url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status} beim Laden von ${this.url}`);
        const json = await res.json();

        const addDef = (key, def) => {
          if (!key || !def || !def.viewBox || !def.svg) return;
          this.map.set(String(key), {
            key: String(key),
            label: def.label || '',
            viewBox: def.viewBox,
            svg: def.svg
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
      }
      return this.loaded;
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
      this._pickerPanel = null;
      this._propsPanel = null;
      this._launcherBtn = null;
      this._styleEl = null;
      this._libraryLoading = false;
      this._ignoreNextContainerClick = false;

      // Config
      this._baseSizePx = Number(this.options.baseSizePx) || 40;
      this._minScale = Number(this.options.minScale) || 0.25;
      this._maxScale = Number(this.options.maxScale) || 6;
      this._ctxMenuId = 'elin-stamp-menu';
      this._acc2dYMode = this.options.acc2dYMode || 'bbox-min'; // 'bbox-min' | 'bbox-max-inverted'

      // Bound handlers
      this._onCameraChange = () => this._updateAllStamps();
      this._onModelLoaded = () => this._onModelRootLoaded();
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

      // Initial load (async, non-blocking)
      this._ensureLibraryLoaded();
      this._onModelRootLoaded();

      return true;
    }

    unload() {
      this.viewer.removeEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, this._onCameraChange);
      this.viewer.removeEventListener(Autodesk.Viewing.MODEL_ROOT_LOADED_EVENT, this._onModelLoaded);

      try { this.viewer.unregisterContextMenuCallback(this._ctxMenuId); } catch (e) { /* ignore */ }

      this.viewer.container.removeEventListener('pointerdown', this._onContainerPointerDownCaptureBound, true);
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
      // Viewer world -> sheet coordinates for TwoDVectorPushpin
      const model = this.viewer && this.viewer.model;
      if (!model) return this._toPlainPos(worldPos);

      const bbox = model.getBoundingBox && model.getBoundingBox();
      if (!bbox || !bbox.min || !bbox.max) return this._toPlainPos(worldPos);

      const x = Number(worldPos.x) - Number(bbox.min.x);
      let y = 0;

      if (this._acc2dYMode === 'bbox-max-inverted') {
        y = Number(bbox.max.y) - Number(worldPos.y);
      } else {
        // Default for many DWG/PDF sheets
        y = Number(worldPos.y) - Number(bbox.min.y);
      }

      return { x: Number(x) || 0, y: Number(y) || 0, z: 0 };
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
        const body = s.el && s.el.querySelector('.elin-stamp__body');
        if (!body) continue;
        body.innerHTML = this._getStampBodySvgHtml(def);
      }
    }

    _getStampBodySvgHtml(def) {
      if (def) {
        return `<svg class="elin-stamp__svg" viewBox="${def.viewBox}" xmlns="http://www.w3.org/2000/svg">${def.svg}</svg>`;
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
            <b>Move:</b> Drag am Stempel. <b>Scale:</b> Drag am Eck-Handle.<br/>
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
      }
    }

    // ----------------------------- UI: properties panel -----------------------------
    _createPropertiesPanel() {
      const panel = document.createElement('div');
      panel.className = 'elin-properties-panel';
      panel.style.display = 'none';

      panel.innerHTML = `
        <div class="elin-properties-panel__title">ELIN Prüfung</div>

        <div class="elin-properties-panel__row">
          <div class="elin-properties-panel__label">Selektiert</div>
          <div class="elin-properties-panel__value" data-role="selcount">0</div>
        </div>

        <div class="elin-properties-panel__row">
          <div class="elin-properties-panel__label">ACC Typ</div>
          <select class="elin-select" data-role="issuetype">
            <option value="allgemein">Allgemein</option>
            <option value="mangel">Mangel</option>
          </select>
        </div>

        <div class="elin-properties-panel__row">
          <div class="elin-properties-panel__label">Skalierung</div>
          <input class="elin-range" type="range" min="0.25" max="6" step="0.05" value="1" data-role="scale" />
        </div>

        <div class="elin-properties-panel__actions">
          <button class="elin-btn" data-action="acc">In ACC Aufgabe umwandeln</button>
          <button class="elin-btn elin-btn--danger" data-action="del">Löschen</button>
        </div>
      `;

      panel.addEventListener('click', (ev) => {
        const accBtn = safeClosest(ev.target, 'button[data-action="acc"]');
        const delBtn = safeClosest(ev.target, 'button[data-action="del"]');

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

      const issueTypeSel = panel.querySelector('[data-role="issuetype"]');
      issueTypeSel.addEventListener('change', () => {
        const v = issueTypeSel.value;
        this._defaultIssueType = v;
        for (const s of this._selected) s.issueType = v;
        this._saveStampsToLocal();
      });

      const scaleRange = panel.querySelector('[data-role="scale"]');
      scaleRange.addEventListener('input', () => {
        const v = clamp(parseFloat(scaleRange.value), this._minScale, this._maxScale);
        for (const s of this._selected) {
          s.scale = v;
          this._updateStampDom(s);
        }
        this._saveStampsToLocal();
      });

      this.viewer.container.appendChild(panel);
      this._propsPanel = panel;
    }

    _updatePropertiesPanel() {
      if (!this._propsPanel) return;

      if (this._selected.length === 0) {
        this._propsPanel.style.display = 'none';
        return;
      }

      this._propsPanel.style.display = 'flex';
      this._propsPanel.querySelector('[data-role="selcount"]').textContent = String(this._selected.length);

      const types = new Set(this._selected.map((s) => s.issueType || 'allgemein'));
      const issueSel = this._propsPanel.querySelector('[data-role="issuetype"]');
      if (types.size === 1) issueSel.value = Array.from(types)[0];
      else issueSel.value = this._defaultIssueType || 'allgemein';

      const scales = this._selected.map((s) => (typeof s.scale === 'number' ? s.scale : 1));
      const avg = scales.reduce((a, b) => a + b, 0) / Math.max(1, scales.length);
      this._propsPanel.querySelector('[data-role="scale"]').value = String(clamp(avg, this._minScale, this._maxScale));
    }

    // ----------------------------- Model/view lifecycle -----------------------------
    _onModelRootLoaded() {
      this._clearAllStampsDom();
      this._clearSelection();
      this._loadStampsFromLocal();
      this._updateAllStamps();
    }

    _currentStorageKey() {
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
      if (!urn) {
        urn = 'unknownUrn';
      }

      const docNode = model.getDocumentNode && model.getDocumentNode();
      const guid = (docNode && docNode.data && docNode.data.guid) ? docNode.data.guid : 'unknownView';
      return `elin_${urn}_${guid}`;
    }

    _saveStampsToLocal() {
      const key = this._currentStorageKey();
      if (!key) return;

      const payload = this._stamps.map((s) => ({
        id: s.id,
        stampKey: s.stampKey,
        worldPos: vecToPlain(s.worldPos),
        scale: (typeof s.scale === 'number' ? s.scale : 1),
        issueType: s.issueType || 'allgemein',
        referenceZoom: s.referenceZoom || 1  // Für absolute Skalierung
      }));

      localStorage.setItem(key, JSON.stringify(payload));
    }

    _loadStampsFromLocal() {
      const key = this._currentStorageKey();
      if (!key) return;

      const raw = localStorage.getItem(key);
      if (!raw) return;

      try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return;

        for (const d of arr) {
          if (!d || !d.stampKey) continue;
          this._createStampInstance({
            id: d.id || uid(),
            stampKey: d.stampKey,
            worldPos: plainToVec3(d.worldPos),
            scale: (typeof d.scale === 'number' ? d.scale : 1),
            issueType: d.issueType || 'allgemein',
            referenceZoom: d.referenceZoom || this._getCurrentZoomFactor()  // Fallback zum aktuellen Zoom
          }, false);
        }
      } catch (e) {
        console.warn('ELIN: Could not parse saved stamps', e);
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
        scale: (typeof data.scale === 'number' ? data.scale : 1),
        issueType: data.issueType || 'allgemein',
        referenceZoom: data.referenceZoom || this._getCurrentZoomFactor(), // Zoom beim Erstellen
        el: null
      };

      stamp.el = this._buildStampElement(stamp, def);
      this.viewer.container.appendChild(stamp.el);
      this._stamps.push(stamp);

      this._updateStampDom(stamp);

      if (save) this._saveStampsToLocal();
      return stamp;
    }

    _buildStampElement(stamp, def) {
      const root = document.createElement('div');
      root.className = 'elin-stamp';
      root.dataset.id = stamp.id;

      root.innerHTML = `
        <div class="elin-stamp__body">${this._getStampBodySvgHtml(def)}</div>
        <div class="elin-stamp__handle" title="Skalieren"></div>
      `;

      // selection + move
      root.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        if (safeClosest(ev.target, '.elin-stamp__handle')) return;

        ev.stopPropagation();
        ev.preventDefault();

        const additive = !!ev.shiftKey;
        const toggle = !!ev.ctrlKey || !!ev.metaKey;

        if (toggle) this._toggleSelection(stamp);
        else this._selectStamp(stamp, additive);

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

      // scale handle
      const handle = root.querySelector('.elin-stamp__handle');
      handle.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;

        ev.stopPropagation();
        ev.preventDefault();

        const additive = !!ev.shiftKey;
        const toggle = !!ev.ctrlKey || !!ev.metaKey;

        if (toggle) this._toggleSelection(stamp);
        else this._selectStamp(stamp, additive);

        const targets = (this._selected.includes(stamp) && this._selected.length > 0)
          ? this._selected.slice()
          : [stamp];

        const center = this.viewer.worldToClient(stamp.worldPos);
        if (!isFinitePoint(center)) return;

        const startScaleById = new Map();
        for (const s of targets) startScaleById.set(s.id, (typeof s.scale === 'number' ? s.scale : 1));

        const baseDist = (this._baseSizePx * 0.5) * Math.sqrt(2);

        this._dragState = {
          mode: 'scale',
          anchorStamp: stamp,
          targets,
          center,
          baseDist,
          anchorStartScale: stamp.scale,
          startScaleById
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

    _onStampPointerMove(ev) {
      if (!this._dragState) return;

      const st = this._dragState;

      if (st.mode === 'move') {
        const world = this._eventToWorldPoint(ev, st.anchorStartWorld);
        if (!world) return;

        const delta = new THREE.Vector3().subVectors(world, st.anchorStartWorld);

        for (const s of st.targets) {
          const startWorld = st.startWorldById.get(s.id);
          if (!startWorld) continue;
          s.worldPos.copy(startWorld.clone().add(delta));
          this._updateStampDom(s);
        }

        this._updatePropertiesPanel();
        return;
      }

      if (st.mode === 'scale') {
        const dx = ev.clientX - st.center.x;
        const dy = ev.clientY - st.center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const anchorScaleFactor = clamp(dist / st.baseDist, this._minScale, this._maxScale);
        const ratio = st.anchorStartScale > 0 ? (anchorScaleFactor / st.anchorStartScale) : 1;

        for (const s of st.targets) {
          const startScale = st.startScaleById.get(s.id) || 1;
          s.scale = clamp(startScale * ratio, this._minScale, this._maxScale);
          this._updateStampDom(s);
        }

        this._updatePropertiesPanel();
      }
    }

    _onStampPointerUp() {
      if (!this._dragState) return;
      this._dragState = null;
      this._saveStampsToLocal();
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
      this._saveStampsToLocal();
    }

    // ----------------------------- ACC sync -----------------------------
    async _sendSelectedToAcc() {
      if (this._selected.length === 0) return;

      const model = this.viewer.model;
      if (!model) throw new Error('Kein Model geladen.');

      const ctx = window.ELIN_TREE_CTX || {};
      if (!ctx.hubId || !ctx.projectId || !ctx.itemId || !ctx.versionId) {
        throw new Error('Fehlende Kontext-IDs. Bitte Blatt in der Sidebar neu auswählen.');
      }

      const selectedHubId = String(ctx.hubId).trim();
      const selectedProjectId = String(ctx.projectId).trim();
      const ctxItemId = String(ctx.itemId).trim();
      const ctxVersionId = String(ctx.versionId).trim();
      const versionMatch = String(ctxVersionId).match(/[?&]version=(\d+)/i);
      const parsedVersion = versionMatch ? parseInt(versionMatch[1], 10) : NaN;
      const createdAtVersion = (Number.isFinite(parsedVersion) && parsedVersion > 0)
        ? parsedVersion
        : 1;

      console.log('[ELIN] Model Debug:', {
        hasGetSeedUrn: typeof model.getSeedUrn === 'function',
        hasGetDocumentNode: typeof model.getDocumentNode === 'function',
        modelType: model.constructor.name
      });

      const docNode = model.getDocumentNode && model.getDocumentNode();
      console.log('[ELIN] DocNode:', docNode);
      
      const viewableId = (docNode && docNode.data && docNode.data.guid) ? docNode.data.guid : null;
      const viewableName = (docNode && docNode.data && docNode.data.name) ? String(docNode.data.name) : 'ELIN Plan Prüfung';

      const linkedDocumentUrn = ctxItemId;

      const is2D = this._is2DModel();
      console.log('[ELIN] Sending to ACC - Model is 2D:', is2D);
      console.log('[ELIN] ViewableId:', viewableId);
      console.log('[ELIN] ViewableName:', viewableName);
      console.log('[ELIN] projectId:', selectedProjectId);
      console.log('[ELIN] hubId:', selectedHubId);
      console.log('[ELIN] itemId:', ctxItemId);
      console.log('[ELIN] versionId:', ctxVersionId);
      console.log('[ELIN] createdAtVersion (strict from versionId):', createdAtVersion);

      const payload = this._selected.map((s) => {
        const def = this._library.get(s.stampKey);
        const label = def ? (def.label || '') : (s.label || '');

        const type = s.issueType || 'allgemein';
        const status = (type === 'mangel') ? 'open' : 'closed';

        const worldPosition = vecToPlain(s.worldPos);
        const accPosition = is2D ? this._getAcc2DPosition(s.worldPos) : worldPosition;
        
        const linkedType = is2D ? 'TwoDVectorPushpin' : 'ThreeDVectorPushpin';
        console.log(`[ELIN] Stamp ${s.id}: linkedDocumentType = ${linkedType}, accPosition =`, accPosition);

        return {
          id: s.id,

          // Backend-Mapping (issueSubtypeId)
          type,
          issueSubtypeId: s.issueSubtypeId || null,
          status,

          // Sichtbarer ACC-Titel + eindeutige Stempel-ID
          title: `ELIN: ${s.stampKey}${label ? ' [' + label + ']' : ''}`,

          // Zusätzliche Metadaten (server kann sie verwenden oder ignorieren)
          stampKey: s.stampKey,
          stampLabel: label,
          scale: Number(s.scale) || 1,
          is3D: !is2D,
          linkedDocumentType: linkedType,

          // Wichtig für 2D ACC Pushpin
          position: accPosition,      // kompatibel zum bestehenden Backend
          accPosition: accPosition,   // explizit
          worldPosition: worldPosition,

          viewId: viewableId,
          viewName: viewableName,
          hubId: selectedHubId,
          projectId: selectedProjectId,
          itemId: ctxItemId,
          versionId: ctxVersionId,
          version: createdAtVersion,
          createdAtVersion,
          linkedDocumentUrn,
          urn: linkedDocumentUrn
        };
      });

      const res = await fetch('/api/issues/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hubId: selectedHubId,
          projectId: selectedProjectId,
          stamps: payload
        })
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

        .elin-input {
          width: 100%;
          box-sizing: border-box;
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid #c7c7c7;
          font-size: 12px;
          outline: none;
        }

        .elin-select {
          width: 100%;
          padding: 6px 10px;
          border-radius: 8px;
          border: 1px solid #c7c7c7;
          font-size: 12px;
          background: #fff;
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
          background: rgba(255,255,255,0.65);
          border-radius: 10px;
          border: 1px solid rgba(0,0,0,0.15);
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 2px 10px rgba(0,0,0,0.12);
          overflow: hidden;
        }

        .elin-stamp__svg { width: 88%; height: 88%; }

        .elin-stamp__handle {
          position: absolute;
          width: 12px;
          height: 12px;
          right: -2px;
          bottom: -2px;
          background: #0096ff;
          border: 2px solid #ffffff;
          border-radius: 4px;
          box-shadow: 0 0 0 1px rgba(0,0,0,0.15);
          cursor: nwse-resize;
        }

        .elin-stamp.selected .elin-stamp__body {
          outline: 2px solid rgba(0,150,255,0.9);
          box-shadow: 0 0 0 3px rgba(0,150,255,0.15), 0 2px 10px rgba(0,0,0,0.18);
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
          width: 280px;
          z-index: 10001;
          background: white;
          border: 1px solid #d0d0d0;
          border-radius: 12px;
          box-shadow: 0 8px 30px rgba(0,0,0,0.18);
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
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
      `;
      document.head.appendChild(style);
      this._styleEl = style;
    }
  }

  Autodesk.Viewing.theExtensionManager.registerExtension('ElinStampExtension', ElinStampExtension);
})();
