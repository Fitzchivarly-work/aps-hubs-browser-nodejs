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

  // Convert THREE.Vector3 or plain object to plain JSON
  function vecToPlain(v) {
    return { x: v.x, y: v.y, z: (typeof v.z === 'number' ? v.z : 0) };
  }

  function plainToVec3(p) {
    if (!p) return new THREE.Vector3(0, 0, 0);
    return new THREE.Vector3(p.x || 0, p.y || 0, p.z || 0);
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

        Object.keys(json).forEach((key) => {
          const def = json[key];
          if (!def || !def.viewBox || !def.svg) return;
          const entry = {
            key,
            label: def.label || '',
            viewBox: def.viewBox,
            svg: def.svg
          };
          this.map.set(key, entry);
        });

        this.list = Array.from(this.map.values()).sort((a, b) => a.key.localeCompare(b.key));
        this.loaded = true;
      } catch (e) {
        this.error = e;
        this.loaded = false;
      }
      return this.loaded;
    }

    get(key) { return this.map.get(key) || null; }

    search(query, limit = 120) {
      const q = (query || '').trim().toLowerCase();
      if (!q) return this.list.slice(0, limit);

      const out = [];
      for (const d of this.list) {
        const hay = (d.key + ' ' + (d.label || '')).toLowerCase();
        if (hay.includes(q)) out.push(d);
        if (out.length >= limit) break;
      }
      return out;
    }
  }

  // ----------------------------- Main Extension -----------------------------
  class ElinStampExtension extends Autodesk.Viewing.Extension {
    constructor(viewer, options) {
        super(viewer, options);
        this._stamps = [];
        this._selectedStamps = [];
        this._currentType = 'ok';

        // Referenz-Pixelgröße (für world-bound scaling in updateStamps)
        this._BASE_PX = 40;

        // ID für Viewer ContextMenu Callback (Right Click)
        this._ctxMenuId = 'elin-stamp-menu';

        // Handler binden, damit wir sie in unload() sauber abmelden können
        this._onCameraChange = () => this.updateStamps();
        this._onModelLoaded = () => {
            this.loadStampsFromLocal();
            this.updateStamps();
        };
    }
        // -------------------- Helpers (keine externen Imports nötig) --------------------

    _toInt(n, fallback = 0) {
        const v = Number(n);
        return Number.isFinite(v) ? Math.round(v) : fallback;
    }

    _toPlainPos(v) {
        // akzeptiert THREE.Vector3 oder {x,y,z}
        if (!v) return { x: 0, y: 0, z: 0 };
        return { x: Number(v.x) || 0, y: Number(v.y) || 0, z: Number(v.z) || 0 };
    }

    _pxPerWorldAt(worldPos) {
        // wie viele Pixel entspricht 1 Welt-Einheit an dieser Stelle?
        const p0 = this.viewer.worldToClient(worldPos);
        const p1 = this.viewer.worldToClient(new THREE.Vector3(worldPos.x + 1, worldPos.y, worldPos.z || 0));
        if (!p0 || !p1) return 1e-6;
        return Math.max(1e-6, Math.hypot(p1.x - p0.x, p1.y - p0.y));
    }

    _getAcc2DPosition(worldPos) {
        // Robust-Ansatz: Viewer-world -> 2D-sheet space über BoundingBox shift
        // (Wenn Pin falsch sitzt: später Y-Variante umstellen, siehe Kommentar)
        const bbox = this.viewer.model.getBoundingBox();
        const x = (worldPos.x - bbox.min.x);
        const yA = (worldPos.y - bbox.min.y);      // Variante A
        // const yB = (bbox.max.y - worldPos.y);   // Variante B (Y invertiert)

        return { x: this._toInt(x), y: this._toInt(yA), z: 0 };
    }

        load() {
        this.injectStyles();
        this.createPropertiesPanel();

        this.viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, this._onCameraChange);
        this.viewer.addEventListener(Autodesk.Viewing.MODEL_ROOT_LOADED_EVENT, this._onModelLoaded);

        // Right Click: Standard Autodesk Context Menu bleibt erhalten, wir fügen nur ELIN-Einträge hinzu
        this.viewer.registerContextMenuCallback(this._ctxMenuId, (menu) => {
            menu.addMenuItem('ELIN: OK-Stempel platzieren', () => {
                this._currentType = 'ok';
                this.activateStampMode();
            });
            menu.addMenuItem('ELIN: Mangel-Stempel platzieren', () => {
                this._currentType = 'mangel';
                this.activateStampMode();
            });

            if (this._selectedStamps.length > 0) {
                menu.addMenuItem(`ELIN: ${this._selectedStamps.length} Stempel löschen`, () => {
                    this.deleteSelectedStamps();
                });
            }
        });

        return true;
    }

    unload() {
        // sauber abmelden (sonst doppelte ContextMenu Items bei Reload)
        this.viewer.removeEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, this._onCameraChange);
        this.viewer.removeEventListener(Autodesk.Viewing.MODEL_ROOT_LOADED_EVENT, this._onModelLoaded);

        try { this.viewer.unregisterContextMenuCallback(this._ctxMenuId); } catch (e) { /* ignore */ }

        this.viewer.canvas.style.cursor = 'default';
        return true;
    }


    // ----------------------------- UI: picker panel -----------------------------
    _createPickerPanel() {
      const panel = document.createElement('div');
      panel.className = 'elin-stamp-picker';
      panel.style.display = 'none';

      panel.innerHTML = `
        <div class="elin-stamp-picker__header">
          <div class="elin-stamp-picker__title">ELIN Stempel</div>
          <button class="elin-btn elin-btn--ghost" data-action="close">✕</button>
        </div>

        <div class="elin-stamp-picker__body">
          <input class="elin-input" type="text" placeholder="Suche (Key/Label) …" data-role="search" />
          <div class="elin-stamp-picker__meta" data-role="meta"></div>
          <div class="elin-stamp-picker__list" data-role="list"></div>
        </div>

        <div class="elin-stamp-picker__footer">
          <div class="elin-stamp-picker__hint">
            <b>Platzieren:</b> Stempel wählen → „Platzieren“ → Klick im Viewer.<br/>
            <b>Move:</b> Drag am Stempel. <b>Scale:</b> Drag am Eck-Handle. <b>Multi-Select:</b> Shift/Ctrl.
          </div>
        </div>
      `;

      panel.addEventListener('click', (ev) => {
        const btn = safeClosest(ev.target, 'button[data-action="close"]');
        if (btn) {
          this._togglePicker(false);
          ev.preventDefault();
          ev.stopPropagation();
        }
      });

      const search = panel.querySelector('[data-role="search"]');
      search.addEventListener('input', () => this._refreshLibraryUI());

      this.viewer.container.appendChild(panel);
      this._pickerPanel = panel;
    }

    _togglePicker(forceOpen) {
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
      const q = (this._pickerPanel.querySelector('[data-role="search"]') || {}).value || '';

      listEl.innerHTML = '';

      if (statusText) {
        meta.textContent = statusText;
        return;
      }

      if (!this._library.loaded) {
        meta.textContent = this._library.error
          ? `Fehler: ${this._library.error.message}`
          : 'Lade stamps.json …';
        return;
      }

      const results = this._library.search(q, 140);
      meta.textContent = `${results.length} Treffer${q ? ` für „${q}“` : ''}`;

      for (const def of results) {
        const row = document.createElement('button');
        row.className = 'elin-stamp-item';
        row.type = 'button';

        // small preview
        row.innerHTML = `
          <span class="elin-stamp-item__preview">
            <svg viewBox="${def.viewBox}" xmlns="http://www.w3.org/2000/svg">
              ${def.svg}
            </svg>
          </span>
          <span class="elin-stamp-item__text">
            <span class="elin-stamp-item__key">${def.key}</span>
            <span class="elin-stamp-item__label">${def.label || ''}</span>
          </span>
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
    }

    _setPlacingMode(on) {
      this._placing = !!on;
      this.viewer.canvas.style.cursor = this._placing ? 'crosshair' : 'default';
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
        const acc = safeClosest(ev.target, 'button[data-action="acc"]');
        const del = safeClosest(ev.target, 'button[data-action="del"]');

        if (acc) {
          ev.preventDefault();
          this._sendSelectedToAcc().catch((e) => {
            console.error(e);
            alert('ACC Fehler: ' + e.message);
          });
        } else if (del) {
          ev.preventDefault();
          this._deleteSelectedStamps();
        }
      });

      const issueTypeSel = panel.querySelector('[data-role="issuetype"]');
      issueTypeSel.addEventListener('change', () => {
        const v = issueTypeSel.value;
        for (const s of this._selected) s.issueType = v;
        this._saveStampsToLocal();
      });

      const scaleRange = panel.querySelector('[data-role="scale"]');
      scaleRange.addEventListener('input', () => {
        const v = parseFloat(scaleRange.value);
        for (const s of this._selected) s.scale = clamp(v, this._minScale, this._maxScale);
        this._updateAllStamps();
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

      // issueType mixed?
      const types = new Set(this._selected.map(s => s.issueType || 'allgemein'));
      const issueSel = this._propsPanel.querySelector('[data-role="issuetype"]');
      if (types.size === 1) {
        issueSel.value = Array.from(types)[0];
      } else {
        // show allgemein but do not force-change; user change will apply to all
        issueSel.value = 'allgemein';
      }

      // scale mixed?
      const scales = this._selected.map(s => (typeof s.scale === 'number' ? s.scale : 1));
      const avg = scales.reduce((a, b) => a + b, 0) / Math.max(1, scales.length);
      this._propsPanel.querySelector('[data-role="scale"]').value = String(clamp(avg, this._minScale, this._maxScale));
    }

    // ----------------------------- Model/view lifecycle -----------------------------
    _onModelRootLoaded() {
      // switching between viewables (DWG sheets / PDF pages) triggers model root loaded
      this._clearAllStampsDom();
      this._clearSelection();
      this._loadStampsFromLocal();
      this._updateAllStamps();
    }

    _currentStorageKey() {
      const model = this.viewer.model;
      if (!model) return null;

      const urn = model.getSeedUrn ? model.getSeedUrn() : 'unknownUrn';
      const docNode = model.getDocumentNode && model.getDocumentNode();
      const guid = (docNode && docNode.data && docNode.data.guid) ? docNode.data.guid : 'unknownView';
      return `elin_${urn}_${guid}`;
    }

    _saveStampsToLocal() {
      const key = this._currentStorageKey();
      if (!key) return;

      const payload = this._stamps.map(s => ({
        id: s.id,
        stampKey: s.stampKey,
        worldPos: vecToPlain(s.worldPos),
        scale: s.scale,
        issueType: s.issueType || 'allgemein'
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
            issueType: d.issueType || 'allgemein'
          }, /*save*/ false);
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
      // ESC exits placing mode
      if (ev.key === 'Escape') {
        this._setPlacingMode(false);
      }

      // Delete removes selected
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (this._selected.length > 0) {
          ev.preventDefault();
          this._deleteSelectedStamps();
        }
      }
    }

    _handleContainerPointerDownCapture(ev) {
      // ignore clicks inside our own UI
      if (safeClosest(ev.target, '.elin-stamp-picker') || safeClosest(ev.target, '.elin-properties-panel')) {
        return;
      }

      // Placing mode: left click on canvas creates a stamp
      if (this._placing && ev.button === 0) {
        const pt = this._eventToWorldPoint(ev, /*fallbackPlanePoint*/ null);
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
        }, /*save*/ true);

        // in placing mode we consume the event so the viewer doesn't also pan/select
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }

      // Not placing: click empty area clears selection
      // (but do not clear if click on a stamp DOM)
      if (!safeClosest(ev.target, '.elin-stamp')) {
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
      const { x, y } = this._eventToCanvasXY(ev);

      // first try viewer.clientToWorld (works well in 2D and on 3D geometry)
      let res = null;
      try {
        res = this.viewer.clientToWorld(x, y, true);
      } catch (e) {
        // ignore
      }
      const p = res ? (res.point || res) : null;
      if (p && typeof p.x === 'number' && typeof p.y === 'number') {
        return new THREE.Vector3(p.x, p.y, (typeof p.z === 'number' ? p.z : 0));
      }

      // fallback: ray-plane intersection for 3D (when cursor not on geometry)
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
        cam.getWorldDirection(n); // normal pointing forward
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

      // If library isn't loaded yet, still allow creation, but render a placeholder
      const stamp = {
        id: data.id || uid(),
        stampKey: data.stampKey,
        label: def ? (def.label || '') : '',
        worldPos: data.worldPos instanceof THREE.Vector3 ? data.worldPos.clone() : plainToVec3(data.worldPos),
        scale: (typeof data.scale === 'number' ? data.scale : 1),
        issueType: data.issueType || 'allgemein',
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

      const svgHtml = def
        ? `<svg class="elin-stamp__svg" viewBox="${def.viewBox}" xmlns="http://www.w3.org/2000/svg">${def.svg}</svg>`
        : `<svg class="elin-stamp__svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
             <rect x="5" y="5" width="90" height="90" fill="none" stroke="#ff0000" stroke-width="5"/>
             <text x="50" y="58" text-anchor="middle" font-size="16" fill="#ff0000">NO LIB</text>
           </svg>`;

      root.innerHTML = `
        <div class="elin-stamp__body">${svgHtml}</div>
        <div class="elin-stamp__handle" title="Skalieren"></div>
      `;

      // selection + move
      root.addEventListener('pointerdown', (ev) => {
        // ignore right click
        if (ev.button !== 0) return;

        // ignore if starting on handle (scale handled separately)
        if (safeClosest(ev.target, '.elin-stamp__handle')) return;

        ev.stopPropagation();
        ev.preventDefault();

        // selection logic
        const additive = !!ev.shiftKey;
        const toggle = !!ev.ctrlKey || !!ev.metaKey;

        if (toggle) {
          this._toggleSelection(stamp);
        } else {
          this._selectStamp(stamp, additive);
        }

        // start move drag
        const startWorld = stamp.worldPos.clone();
        const { x, y } = this._eventToCanvasXY(ev);
        const start = { clientX: ev.clientX, clientY: ev.clientY, canvasX: x, canvasY: y };

        this._dragState = { mode: 'move', stamp, startWorld, start };
        root.setPointerCapture(ev.pointerId);

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

        if (toggle) {
          this._toggleSelection(stamp);
        } else {
          this._selectStamp(stamp, additive);
        }

        // start scaling: based on distance from center
        const center = this.viewer.worldToClient(stamp.worldPos);
        const baseDist = (this._baseSizePx * 0.5) * Math.sqrt(2);

        this._dragState = {
          mode: 'scale',
          stamp,
          center,
          baseDist,
          startScale: stamp.scale
        };

        root.setPointerCapture(ev.pointerId);

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
      const stamp = st.stamp;

      if (st.mode === 'move') {
        // try clientToWorld; if no hit, fallback to plane through original world point
        const world = this._eventToWorldPoint(ev, st.startWorld);
        if (!world) return;

        stamp.worldPos.copy(world);
        this._updateStampDom(stamp);
        this._updatePropertiesPanel();
      }

      if (st.mode === 'scale') {
        const dx = ev.clientX - st.center.x;
        const dy = ev.clientY - st.center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        const scale = clamp(dist / st.baseDist, this._minScale, this._maxScale);
        stamp.scale = scale;

        this._updateStampDom(stamp);
        this._updatePropertiesPanel();
      }
    }

    _onStampPointerUp(ev) {
      if (!this._dragState) return;
      this._dragState = null;
      this._saveStampsToLocal();
    }

    _updateStampDom(stamp) {
      const p = this.viewer.worldToClient(stamp.worldPos);
      if (!p) return;

      stamp.el.style.left = `${p.x}px`;
      stamp.el.style.top = `${p.y}px`;
      stamp.el.style.transform = `translate(-50%, -50%) scale(${stamp.scale || 1})`;
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
        stamp.el.classList.add('selected');
      }

      this._updatePropertiesPanel();
    }

    _toggleSelection(stamp) {
      const idx = this._selected.indexOf(stamp);
      if (idx >= 0) {
        this._selected.splice(idx, 1);
        stamp.el.classList.remove('selected');
      } else {
        this._selected.push(stamp);
        stamp.el.classList.add('selected');
      }
      this._updatePropertiesPanel();
    }

    _clearSelection() {
      for (const s of this._selected) s.el.classList.remove('selected');
      this._selected = [];
      this._updatePropertiesPanel();
    }

    // ----------------------------- Delete -----------------------------
    _deleteSelectedStamps() {
      if (this._selected.length === 0) return;

      const toDelete = new Set(this._selected.map(s => s.id));

      // remove from DOM + array
      this._stamps = this._stamps.filter(s => {
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

      const docNode = model.getDocumentNode && model.getDocumentNode();
      const viewableId = (docNode && docNode.data && docNode.data.guid) ? docNode.data.guid : null;

      const fullUrn = model.getSeedUrn ? model.getSeedUrn() : null;
      const versionNum = (docNode && docNode.data && docNode.data.versionNumber) ? parseInt(docNode.data.versionNumber, 10) : 1;

      if (!fullUrn) throw new Error('URN konnte nicht ermittelt werden.');

      // IMPORTANT: Wir übergeben den Stempel eindeutig über title + stampKey/stampLabel.
      // Dein Backend erwartet aktuell stamp.type ('mangel' oder nicht) und status :contentReference[oaicite:6]{index=6}.
      // -> Wir nutzen issueType als stamp.type und setzen status entsprechend.
      const payload = this._selected.map(s => {
        const def = this._library.get(s.stampKey);
        const label = def ? (def.label || '') : (s.label || '');

        const type = s.issueType || 'allgemein';
        const status = (type === 'mangel') ? 'open' : 'closed';

        return {
          id: s.id,

          // Backend-Mapping (issueSubtypeId)
          type: type,
          status: status,

          // Für ACC sichtbar: enthält den gewählten Stempel
          title: `ELIN: ${s.stampKey}${label ? ' [' + label + ']' : ''}`,

          // Zusatzfelder (optional, backend darf sie ignorieren)
          stampKey: s.stampKey,
          stampLabel: label,
          scale: s.scale,

          position: vecToPlain(s.worldPos),
          viewId: viewableId,
          urn: fullUrn,
          version: versionNum
        };
      });

      const res = await fetch('/api/issues/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stamps: payload })
      });

      if (!res.ok) {
        let msg = res.statusText;
        try {
          const err = await res.json();
          if (err && err.message) msg = err.message;
        } catch (e) {
          // ignore
        }
        throw new Error(msg);
      }

      alert(`Erfolgreich: ${this._selected.length} Aufgabe(n) in ACC erstellt.`);
    }

    // ----------------------------- Styles -----------------------------
    _injectStyles() {
      const style = document.createElement('style');
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
        .elin-btn--ghost { border: none; background: transparent; font-size: 14px; }

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

        .elin-range {
          width: 100%;
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

        .elin-stamp__svg {
          width: 88%;
          height: 88%;
        }

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
          top: 10px;
          left: 10px;
          width: 360px;
          max-height: 70%;
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
          padding: 10px 10px;
          border-bottom: 1px solid #eee;
        }
        .elin-stamp-picker__title { font-weight: 700; font-size: 13px; }
        .elin-stamp-picker__body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
        .elin-stamp-picker__meta { font-size: 11px; color: #666; }
        .elin-stamp-picker__list {
          overflow: auto;
          border: 1px solid #eee;
          border-radius: 10px;
          max-height: 360px;
        }

        .elin-stamp-item {
          width: 100%;
          display: grid;
          grid-template-columns: 40px 1fr;
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

        .elin-stamp-picker__footer {
          border-top: 1px solid #eee;
          padding: 10px;
          font-size: 11px;
          color: #666;
          background: #fafafa;
        }

        /* Properties panel */
        .elin-properties-panel {
          position: absolute;
          top: 10px;
          right: 10px;
          width: 260px;
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
    }
  }

  Autodesk.Viewing.theExtensionManager.registerExtension('ElinStampExtension', ElinStampExtension);
})();