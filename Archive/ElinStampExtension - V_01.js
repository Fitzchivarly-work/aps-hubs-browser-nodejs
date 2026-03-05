class ElinStampExtension extends Autodesk.Viewing.Extension {
    constructor(viewer, options) {
        super(viewer, options);
        this._stamps = [];
        this._currentType = 'ok'; 
    }

    load() {
        console.log('ELIN Stempel: Extension aktiv.');
        this.viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, () => this.updateStamps());
        
        this.viewer.addEventListener(Autodesk.Viewing.MODEL_ROOT_LOADED_EVENT, () => {
            this.loadStampsFromLocal();
        });
        return true;
    }

    onToolbarCreated() {
        const group = this.viewer.toolbar.getControl('ElinToolbar') || new Autodesk.Viewing.UI.ControlGroup('ElinToolbar');
        this.viewer.toolbar.addControl(group);

        const btnOk = new Autodesk.Viewing.UI.Button('ElinStampOk');
        btnOk.onClick = () => { this._currentType = 'ok'; this.activateStampMode(); };
        btnOk.container.innerText = "OK";
        btnOk.container.style.color = "#005aa9";
        group.addControl(btnOk);

        const btnMangel = new Autodesk.Viewing.UI.Button('ElinStampMangel');
        btnMangel.onClick = () => { this._currentType = 'mangel'; this.activateStampMode(); };
        btnMangel.container.innerText = "!";
        btnMangel.container.style.color = "red";
        group.addControl(btnMangel);
    }

    activateStampMode() {
        this.viewer.canvas.style.cursor = 'crosshair';
        
        const onMouseClick = (event) => {
            const rect = this.viewer.container.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;

            let worldPoint = null;

            if (this.viewer.model.is2d()) {
                const res = this.viewer.clientToWorld(x, y);
                // FIX: Wir holen den echten Vector3 aus dem 'point'-Objekt heraus
                worldPoint = res ? (res.point || res) : null;
            } else {
                const result = this.viewer.impl.hitTest(x, y);
                if (result) worldPoint = result.intersectPoint;
            }

            // Sicherstellen, dass worldPoint und X existieren, bevor wir stempeln
            if (worldPoint && worldPoint.x !== undefined) {
                this.createSvgStamp(worldPoint, this._currentType);
            } else {
                console.warn("⚠️ Klick-Koordinate konnte nicht berechnet werden.");
            }

            this.viewer.canvas.style.cursor = 'default';
            this.viewer.container.removeEventListener('click', onMouseClick);
        };
        
        this.viewer.container.removeEventListener('click', onMouseClick);
        this.viewer.container.addEventListener('click', onMouseClick);
    }

    createSvgStamp(worldPoint, type, save = true) {
        const stampId = 'stamp-' + Date.now();
        const zPos = worldPoint.z !== undefined ? worldPoint.z : 0; 
        
        const stampData = {
            id: stampId,
            type: type,
            worldPos: new THREE.Vector3(worldPoint.x, worldPoint.y, zPos),
            element: document.createElement('div')
        };

        const color = type === 'ok' ? '#005aa9' : '#ff0000';
        const text = type === 'ok' ? 'OK' : '!';

        stampData.element.style.position = 'absolute';
        stampData.element.style.zIndex = '1000'; 
        stampData.element.style.pointerEvents = 'none';
        
        // Stempel Design (Ohne roten Debug-Rand)
        stampData.element.innerHTML = `
            <svg width="40" height="40" viewBox="0 0 100 100" style="overflow: visible;">
                <circle cx="50" cy="50" r="40" stroke="${color}" stroke-width="8" fill="white" fill-opacity="0.9" />
                <text x="50" y="65" font-family="Arial" font-size="40" fill="${color}" text-anchor="middle" font-weight="bold">${text}</text>
            </svg>`;

        this.viewer.container.appendChild(stampData.element);
        this._stamps.push(stampData);
        
        this.updateStamps();
        if (save) this.saveStampsToLocal();
    }

    saveStampsToLocal() {
        if (!this.viewer.model) return;
        const urn = this.viewer.model.getSeedUrn();
        const viewId = this.viewer.model.getDocumentNode().data.guid; 
        const data = this._stamps.map(s => ({ 
            id: s.id, 
            type: s.type, 
            worldPos: { x: s.worldPos.x, y: s.worldPos.y, z: s.worldPos.z } 
        }));
        localStorage.setItem('elin_stamps_' + urn + '_' + viewId, JSON.stringify(data));
    }

    loadStampsFromLocal() {
        if (!this.viewer.model) return;
        this._stamps.forEach(s => s.element.remove());
        this._stamps = [];

        const urn = this.viewer.model.getSeedUrn();
        const viewId = this.viewer.model.getDocumentNode().data.guid;
        const saved = localStorage.getItem('elin_stamps_' + urn + '_' + viewId);
        if (saved) {
            JSON.parse(saved).forEach(d => this.createSvgStamp(d.worldPos, d.type, false));
        }
    }

    updateStamps() {
        this._stamps.forEach(stamp => {
            const screenPos = this.viewer.worldToClient(stamp.worldPos);
            
            if (screenPos) {
                stamp.element.style.left = (screenPos.x - 20) + 'px';
                stamp.element.style.top = (screenPos.y - 20) + 'px';
                
                if (!this.viewer.model.is2d()) {
                    const camera = this.viewer.getCamera();
                    const dot = new THREE.Vector3().subVectors(stamp.worldPos, camera.position).dot(camera.getWorldDirection(new THREE.Vector3()));
                    stamp.element.style.display = dot < 0 ? 'none' : 'block';
                } else {
                    stamp.element.style.display = 'block';
                }
            }
        });
    }
}
Autodesk.Viewing.theExtensionManager.registerExtension('ElinStampExtension', ElinStampExtension);