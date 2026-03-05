class ElinStampExtension extends Autodesk.Viewing.Extension {
    constructor(viewer, options) {
        super(viewer, options);
        this._stamps = [];
        this._selectedStamps = [];
        this._currentType = 'ok';
    }

    load() {
        this.injectStyles();
        this.createPropertiesPanel();
        this.viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, () => this.updateStamps());
        this.viewer.addEventListener(Autodesk.Viewing.MODEL_ROOT_LOADED_EVENT, () => this.loadStampsFromLocal());
        return true;
    }

    onToolbarCreated() {
        const group = new Autodesk.Viewing.UI.ControlGroup('ElinToolbar');
        this.viewer.toolbar.addControl(group);

        const btnOk = new Autodesk.Viewing.UI.Button('ElinStampOk');
        btnOk.onClick = () => { this._currentType = 'ok'; this.activateStampMode(); };
        btnOk.container.innerText = "OK";
        group.addControl(btnOk);

        const btnMangel = new Autodesk.Viewing.UI.Button('ElinStampMangel');
        btnMangel.onClick = () => { this._currentType = 'mangel'; this.activateStampMode(); };
        btnMangel.container.innerText = "!";
        group.addControl(btnMangel);
    }

    activateStampMode() {
        this.viewer.canvas.style.cursor = 'crosshair';
        const onMouseClick = (event) => {
            const rect = this.viewer.container.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            let res = this.viewer.clientToWorld(x, y);
            let worldPoint = res ? (res.point || res) : null;

            if (worldPoint) this.createSvgStamp(worldPoint, this._currentType);
            this.viewer.canvas.style.cursor = 'default';
            this.viewer.container.removeEventListener('click', onMouseClick);
        };
        this.viewer.container.addEventListener('click', onMouseClick);
    }

    createSvgStamp(worldPoint, type, save = true) {
        const stampData = {
            id: 'stamp-' + Date.now(),
            type: type,
            worldPos: new THREE.Vector3(worldPoint.x, worldPoint.y, worldPoint.z || 0),
            element: document.createElement('div')
        };
        const color = type === 'ok' ? '#005aa9' : '#ff0000';
        stampData.element.className = 'elin-stamp';
        stampData.element.style.position = 'absolute';
        stampData.element.style.zIndex = '1000';
        stampData.element.style.pointerEvents = 'auto';
        stampData.element.innerHTML = `<svg width="40" height="40"><circle cx="20" cy="20" r="18" stroke="${color}" stroke-width="4" fill="white" fill-opacity="0.8" /><text x="20" y="26" font-family="Arial" font-size="20" fill="${color}" text-anchor="middle" font-weight="bold">${type === 'ok' ? 'OK' : '!'}</text></svg>`;
        
        stampData.element.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.onStampRightClick(e, stampData);
        });

        this.viewer.container.appendChild(stampData.element);
        this._stamps.push(stampData);
        this.updateStamps();
        if (save) this.saveStampsToLocal();
    }

    onStampRightClick(event, stampData) {
        if (!event.ctrlKey) this._selectedStamps.forEach(s => s.element.classList.remove('selected')), this._selectedStamps = [];
        this._selectedStamps.push(stampData);
        stampData.element.classList.add('selected');
        this.updatePropertiesPanel();
    }

    createPropertiesPanel() {
        this._panel = document.createElement('div');
        this._panel.className = 'elin-properties-panel';
        this.viewer.container.appendChild(this._panel);
    }

    updatePropertiesPanel() {
        if (this._selectedStamps.length === 0) return this._panel.style.display = 'none';
        this._panel.style.display = 'flex';
        this._panel.innerHTML = `<h3>ELIN Prüfung</h3><button id="btn-acc">In ACC Aufgabe umwandeln</button><button id="btn-del">Löschen</button>`;
        
// In ElinStampExtension.js innerhalb von updatePropertiesPanel()
        document.getElementById('btn-acc').onclick = async () => {
            const model = this.viewer.model;
            const docNode = model.getDocumentNode();
            
            // Die korrekte Version-URN (wird im Backend dekodiert)
            const fullUrn = model.getSeedUrn(); 
            // Die spezifische GUID der aktuellen Ansicht/Seite
            const viewableId = docNode.data.guid; 
            // Die Versionsnummer als Zahl
            const versionNum = parseInt(docNode.data.versionNumber) || 1;

            const data = this._selectedStamps.map(s => ({
                id: s.id,
                type: s.type,
                status: s.type === 'mangel' ? 'open' : 'closed',
                title: `ELIN: ${s.type}`,
                position: s.worldPos,
                viewId: viewableId, // Präzise Ansichts-ID
                urn: fullUrn,
                version: versionNum
            }));

            const res = await fetch('/api/issues/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stamps: data })
            });

            if (res.ok) {
                alert("Erfolgreich in ACC erstellt! Sie erscheinen dort jetzt als offizielle Aufgaben.");
                // Optional: Stempel lokal entfernen, da sie nun "echte" ACC Issues sind
            } else {
                const errData = await res.json();
                console.error("Fehler-Details:", errData);
                alert("Fehler: " + errData.message);
            }
        };
    }

    injectStyles() {
        const style = document.createElement('style');
        style.innerHTML = `.elin-stamp.selected { filter: drop-shadow(0 0 5px #0096ff); } .elin-properties-panel { display: none; position: absolute; top: 10px; right: 10px; background: white; padding: 15px; z-index: 10001; flex-direction: column; border: 1px solid #ccc; gap: 5px; }`;
        document.head.appendChild(style);
    }

    saveStampsToLocal() {
        const model = this.viewer.model;
        if (model) localStorage.setItem('elin_' + model.getSeedUrn() + '_' + model.getDocumentNode().data.guid, JSON.stringify(this._stamps.map(s => ({ id: s.id, type: s.type, worldPos: s.worldPos }))));
    }

    loadStampsFromLocal() {
        const model = this.viewer.model;
        if (!model) return;
        this._stamps.forEach(s => s.element.remove()); this._stamps = [];
        const saved = localStorage.getItem('elin_' + model.getSeedUrn() + '_' + model.getDocumentNode().data.guid);
        if (saved) JSON.parse(saved).forEach(d => this.createSvgStamp(d.worldPos, d.type, false));
    }

    updateStamps() {
        this._stamps.forEach(s => {
            const p = this.viewer.worldToClient(s.worldPos);
            if (p) { s.element.style.left = (p.x - 20) + 'px'; s.element.style.top = (p.y - 20) + 'px'; s.element.style.display = 'block'; }
        });
    }
}
Autodesk.Viewing.theExtensionManager.registerExtension('ElinStampExtension', ElinStampExtension);