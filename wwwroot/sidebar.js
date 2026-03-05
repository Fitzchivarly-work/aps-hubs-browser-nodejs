async function getJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
        alert('Could not load tree data. See console for more details.');
        console.error(await resp.text());
        return [];
    }
    return resp.json();
}

function createTreeNode(id, text, icon, children = false) {
    return { id, text, children, itree: { icon } };
}

async function getHubs() {
    const hubs = await getJSON('/api/hubs');
    return hubs.map(hub => createTreeNode(`hub|${hub.id}`, hub.name, 'icon-hub', true));
}

async function getProjects(hubId) {
    const projects = await getJSON(`/api/hubs/${hubId}/projects`);
    return projects.map(project => createTreeNode(`project|${hubId}|${project.id}`, project.name, 'icon-project', true));
}

async function getContents(hubId, projectId, folderId = null) {
    const contents = await getJSON(`/api/hubs/${hubId}/projects/${projectId}/contents` + (folderId ? `?folder_id=${folderId}` : ''));
    return contents.map(item => {
        if (item.folder) {
            return createTreeNode(`folder|${hubId}|${projectId}|${item.id}`, item.name, 'icon-my-folder', true);
        } else {
            return createTreeNode(`item|${hubId}|${projectId}|${item.id}`, item.name, 'icon-item', true);
        }
    });
}

async function getVersions(hubId, projectId, itemId) {
    const versions = await getJSON(`/api/hubs/${hubId}/projects/${projectId}/contents/${itemId}/versions`);
    return versions.map(version => createTreeNode(`version|${version.id}`, version.name, 'icon-version'));
}

export function initTree(selector, onSelectionChanged) {
    // See http://inspire-tree.com
    const tree = new InspireTree({
        data: function (node) {
            if (!node || !node.id) {
                return getHubs();
            } else {
                const tokens = node.id.split('|');
                switch (tokens[0]) {
                    case 'hub': return getProjects(tokens[1]);
                    case 'project': return getContents(tokens[1], tokens[2]);
                    case 'folder': return getContents(tokens[1], tokens[2], tokens[3]);
                    case 'item': return getVersions(tokens[1], tokens[2], tokens[3]);
                    default: return [];
                }
            }
        }
    });
    tree.on('node.click', function (event, node) {
        event.preventTreeDefault();
        const tokens = node.id.split('|');

        // Globale Ablage: hubId/projectId/itemId/versionId
        window.ELIN_TREE_CTX = window.ELIN_TREE_CTX || {};

        if (tokens[0] === 'project') {
            // project|<hubId>|<projectId>
            window.ELIN_TREE_CTX.hubId = tokens[1];
            window.ELIN_TREE_CTX.projectId = tokens[2];
            console.log('TREE DEBUG project selected:', { hubId: tokens[1], projectId: tokens[2] });
        }

        if (tokens[0] === 'item') {
            // item|<hubId>|<projectId>|<itemId>
            window.ELIN_TREE_CTX.hubId = tokens[1];
            window.ELIN_TREE_CTX.projectId = tokens[2];
            window.ELIN_TREE_CTX.itemId = tokens[3];
            console.log('TREE DEBUG item selected:', { hubId: tokens[1], projectId: tokens[2], itemId: tokens[3] });
        }

        if (tokens[0] === 'version') {
            // version|<versionId>
            window.ELIN_TREE_CTX.versionId = tokens[1];
            console.log('TREE DEBUG version selected:', { ...window.ELIN_TREE_CTX });
            onSelectionChanged(tokens[1]);
        }
    });
    return new InspireTreeDOM(tree, { target: selector });
}
