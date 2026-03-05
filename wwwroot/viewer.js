/// <reference types="autodesk-viewer" />

async function getAccessToken(callback) {
    try {
        const resp = await fetch('/api/auth/token');
        const { access_token, expires_in } = await resp.json();
        callback(access_token, expires_in);
    } catch (err) {
        console.error(err);
    }
}

export function initViewer(container) {
    return new Promise(function (resolve) {
        const options = {
            env: 'AutodeskProduction2', 
            api: 'derivativeV2_EU', // WICHTIG für Europa-Server
            getAccessToken: getAccessToken
        };
        Autodesk.Viewing.Initializer(options, function () {
            const config = { extensions: ['ElinStampExtension', 'Autodesk.DocumentBrowser'] };
            const viewer = new Autodesk.Viewing.GuiViewer3D(container, config);
            viewer.start();
            viewer.setTheme('light-theme');
            resolve(viewer);
        });
    });
}

export function loadModel(viewer, urn) {
    const documentId = urn.startsWith('urn:') ? urn : 'urn:' + urn;
    Autodesk.Viewing.Document.load(documentId, (doc) => {
        viewer.loadDocumentNode(doc, doc.getRoot().getDefaultGeometry());
    });
}