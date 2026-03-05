const express = require('express');
const session = require('cookie-session');
const { PORT, SERVER_SESSION_SECRET } = require('./config.js');
const SERVER_BUILD = '2026-03-04-2d-markup-stable';
const PROJECT_ID = "bd116dfe-b5d8-4cf9-98ed-68bb5316db04";
const SUBTYPE_ID_MANGEL = "3f0a4ddd-8377-465c-835c-ad72b8aa2439";
const SUBTYPE_ID_ALLGEMEIN = "2c12ca9f-5317-5200-b91f-8c7094cd42e4";
const ACC_MARKUPS_POST_URL = process.env.ACC_MARKUPS_POST_URL || '';

function normalizeProjectId(projectId) {
    if (!projectId) return '';
    const raw = String(projectId).trim();
    if (!raw) return '';
    return raw.startsWith('b.') ? raw.slice(2) : raw;
}

function normalizeProjectIdWithPrefix(projectId) {
    if (!projectId) return '';
    const raw = String(projectId).trim();
    if (!raw) return '';
    return raw.startsWith('b.') ? raw : `b.${raw}`;
}

function normalizeHubId(hubId) {
    if (!hubId) return '';
    const raw = String(hubId).trim();
    if (!raw) return '';
    return raw.startsWith('b.') ? raw : `b.${raw}`;
}

function isLineageUrn(value) {
    const urn = String(value || '').trim();
    return /^urn:adsk\.[^:]+:dm\.lineage:[^?]+$/i.test(urn);
}

function parseVersionFromVersionUrn(rawVersionUrn, fallbackVersion) {
    const decoded = decodeAutodeskUrn(rawVersionUrn || '');
    const match = decoded.match(/[?&]version=(\d+)/i);
    if (match) {
        const v = parseInt(match[1], 10);
        if (Number.isFinite(v) && v > 0) return v;
    }
    const fv = Number(fallbackVersion);
    return Number.isFinite(fv) && fv > 0 ? Math.round(fv) : 1;
}

function isActiveSubtype(sub) {
    if (!sub || typeof sub !== 'object') return false;

    if (typeof sub.active === 'boolean') return sub.active;
    if (typeof sub.isActive === 'boolean') return sub.isActive;

    const status = String(sub.status || sub.state || '').trim().toLowerCase();
    if (status) return status === 'active' || status === 'enabled';

    if (typeof sub.disabled === 'boolean') return !sub.disabled;
    if (typeof sub.deleted === 'boolean') return !sub.deleted;

    // If tenant payload has no explicit activity flags, treat subtype as usable.
    return true;
}

async function fetchIssueTypeCatalog({ token, projectId }) {
    const normalizedProjectId = normalizeProjectId(projectId);
    if (!normalizedProjectId) {
        return { ok: false, error: 'missing projectId', results: [], activeSubtypeIds: new Set(), firstActiveSubtypeId: '' };
    }

    const apiUrl = `https://developer.api.autodesk.com/construction/issues/v1/projects/${normalizedProjectId}/issue-types?include=subtypes`;
    const response = await fetch(apiUrl, {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    const text = await response.text();
    if (!response.ok) {
        return {
            ok: false,
            error: `Issue-Typen konnten nicht geladen werden (${response.status} ${response.statusText}): ${text}`,
            results: [],
            activeSubtypeIds: new Set(),
            firstActiveSubtypeId: ''
        };
    }

    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { parsed = { results: [] }; }

    const results = Array.isArray(parsed.results) ? parsed.results : [];
    const activeSubtypeIds = new Set();
    let firstActiveSubtypeId = '';

    for (const type of results) {
        const subtypes = Array.isArray(type && type.subtypes) ? type.subtypes : [];
        for (const sub of subtypes) {
            if (!sub || !sub.id) continue;
            if (!isActiveSubtype(sub)) continue;
            const id = String(sub.id);
            activeSubtypeIds.add(id);
            if (!firstActiveSubtypeId) firstActiveSubtypeId = id;
        }
    }

    return { ok: true, results, activeSubtypeIds, firstActiveSubtypeId };
}

function uniqueNonEmpty(values) {
    const out = [];
    const seen = new Set();
    for (const v of values || []) {
        const s = String(v || '').trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    return out;
}

function extractIssuesContainerId(payload) {
    if (!payload || typeof payload !== 'object') return '';

    if (payload.issuesContainerId) return String(payload.issuesContainerId).trim();
    if (payload.issueContainerId) return String(payload.issueContainerId).trim();

    const data = payload.data || {};
    const attrs = data.attributes || {};
    if (attrs.issuesContainerId) return String(attrs.issuesContainerId).trim();

    const extData = attrs.extension && attrs.extension.data ? attrs.extension.data : {};
    if (extData.issuesContainerId) return String(extData.issuesContainerId).trim();
    if (extData.projectGuid) return String(extData.projectGuid).trim();

    const relationships = data.relationships || {};
    const issuesRel = relationships.issues || {};
    const issuesRelData = issuesRel.data;
    if (Array.isArray(issuesRelData) && issuesRelData.length > 0 && issuesRelData[0] && issuesRelData[0].id) {
        return String(issuesRelData[0].id).trim();
    }
    if (issuesRelData && issuesRelData.id) {
        return String(issuesRelData.id).trim();
    }

    const issuesContainer = relationships.issuesContainer || relationships.issueContainer || {};
    const relData = issuesContainer.data || {};
    if (relData.id) return String(relData.id).trim();

    const services = Array.isArray(payload.services)
        ? payload.services
        : (Array.isArray(data.services) ? data.services : []);
    for (const svc of services) {
        if (!svc) continue;
        const serviceId = String(svc.id || svc.serviceId || '').trim().toLowerCase();
        if (serviceId !== 'issues') continue;
        const containerId = String(svc.containerId || svc.containerID || svc.idValue || '').trim();
        if (containerId) return containerId;
    }

    const relationshipServices = (data.relationships && data.relationships.services && Array.isArray(data.relationships.services.data))
        ? data.relationships.services.data
        : [];
    const included = Array.isArray(payload.included) ? payload.included : [];
    for (const rel of relationshipServices) {
        const relId = String((rel && rel.id) || '').trim();
        if (!relId) continue;
        const svc = included.find((x) => x && String(x.id || '').trim() === relId);
        if (!svc) continue;
        const attrs2 = svc.attributes || {};
        const serviceId = String(attrs2.id || attrs2.serviceId || svc.id || '').trim().toLowerCase();
        if (serviceId !== 'issues') continue;
        const containerId = String(attrs2.containerId || attrs2.containerID || '').trim();
        if (containerId) return containerId;
    }

    return '';
}

async function fetchIssuesContainerId({ token, projectId, hubId }) {
    const rawProjectId = String(projectId || '').trim();
    const normalized = normalizeProjectId(rawProjectId);
    if (!rawProjectId && !normalized) {
        return { ok: false, issuesContainerId: '', error: 'missing projectId' };
    }

    const hubNormalized = normalizeHubId(hubId);
    const candidateProjectIds = uniqueNonEmpty([
        rawProjectId,
        normalizeProjectIdWithPrefix(rawProjectId),
        normalized,
        normalizeProjectIdWithPrefix(normalized)
    ]);
    const tried = [];

    if (!hubNormalized) {
        return {
            ok: false,
            issuesContainerId: '',
            error: 'missing hubId for ACC project lookup',
            tried
        };
    }

    const endpointCandidates = [];
    for (const pid of candidateProjectIds) {
        endpointCandidates.push({
            projectIdUsed: pid,
            url: `https://developer.api.autodesk.com/project/v1/hubs/${encodeURIComponent(hubNormalized)}/projects/${encodeURIComponent(pid)}`
        });
    }

    for (const candidate of endpointCandidates) {
        const url = candidate.url;
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            const text = await response.text();
            if (!response.ok) {
                console.warn('⚠️ project lookup failed:', {
                    url,
                    status: response.status,
                    statusText: response.statusText,
                    body: text
                });
                tried.push({ url, status: response.status, statusText: response.statusText, body: text });
                continue;
            }

            let parsed = null;
            try { parsed = JSON.parse(text); } catch (e) { parsed = {}; }
            console.log('📄 project lookup response:', {
                url,
                projectIdUsed: candidate.projectIdUsed,
                hubIdUsed: hubNormalized || null,
                payload: parsed
            });
            const issuesContainerId = extractIssuesContainerId(parsed);
            return {
                ok: true,
                issuesContainerId,
                url,
                projectIdUsed: candidate.projectIdUsed,
                hubIdUsed: hubNormalized || null,
                raw: parsed
            };
        } catch (err) {
            tried.push({ url, error: err && err.message ? err.message : String(err) });
        }
    }

    return { ok: false, issuesContainerId: '', tried };
}

function buildMarkupEndpointCandidates(versionUrn) {
    const encodedVersionUrn = encodeURIComponent(versionUrn);

    if (ACC_MARKUPS_POST_URL) {
        // Optional placeholders for env override:
        // {projectId}, {versionUrn}
        const expanded = ACC_MARKUPS_POST_URL
            .replaceAll('{projectId}', PROJECT_ID)
            .replaceAll('{versionUrn}', encodedVersionUrn);
        return [expanded];
    }

    // Fallback candidates (APS docs for markups changed over time).
    return [
        `https://developer.api.autodesk.com/construction/markups/v1/projects/${PROJECT_ID}/markups`,
        `https://developer.api.autodesk.com/construction/markups/v2/projects/${PROJECT_ID}/markups`,
        `https://developer.api.autodesk.com/construction/markups/v1/projects/${PROJECT_ID}/versions/${encodedVersionUrn}/markups`,
        `https://developer.api.autodesk.com/construction/markups/v2/projects/${PROJECT_ID}/versions/${encodedVersionUrn}/markups`
    ];
}

function decodeAutodeskUrn(rawUrn) {
    if (!rawUrn) return '';
    const urn = String(rawUrn).trim();
    if (!urn) return '';
    if (urn.startsWith('urn:adsk')) return urn;
    try {
        return Buffer.from(urn, 'base64').toString('utf-8');
    } catch (e) {
        return urn;
    }
}

function resolveVersionUrn(stamp) {
    const explicit = decodeAutodeskUrn(stamp.versionUrn || '');
    if (explicit && explicit.startsWith('urn:adsk')) return explicit;

    const decodedFromUrn = decodeAutodeskUrn(stamp.urn || '');
    if (!decodedFromUrn || !decodedFromUrn.startsWith('urn:adsk')) return '';

    // versionUrn should point to a concrete file version (fs.file:vf...) including version query.
    if (decodedFromUrn.includes('?version=')) return decodedFromUrn;
    if (stamp.version && Number.isFinite(Number(stamp.version))) {
        const separator = decodedFromUrn.includes('?') ? '&' : '?';
        return `${decodedFromUrn}${separator}version=${Math.max(1, Math.round(Number(stamp.version)))}`;
    }
    return decodedFromUrn;
}

function extractVersionNumber(decodedUrn, fallbackVersion) {
    const fallback = Number.isFinite(Number(fallbackVersion)) ? Math.max(1, Math.round(Number(fallbackVersion))) : 1;
    if (!decodedUrn || typeof decodedUrn !== 'string') return fallback;
    const match = decodedUrn.match(/[?&]version=(\d+)/i);
    if (!match) return fallback;
    const value = parseInt(match[1], 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function getIssueById({ token, projectId, issueId }) {
    const response = await fetch(`https://developer.api.autodesk.com/construction/issues/v1/projects/${projectId}/issues/${issueId}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`
        }
    });

    const text = await response.text();
    if (!response.ok) {
        return {
            exists: false,
            status: response.status,
            statusText: response.statusText,
            raw: text
        };
    }

    try {
        return { exists: true, issue: JSON.parse(text) };
    } catch (e) {
        return { exists: true, issue: { id: issueId, raw: text } };
    }
}

async function createIssuePushpinFallback({ token, stamp }) {
    const decodedUrnFull = decodeAutodeskUrn(stamp.urn || stamp.versionUrn || '');
    const decodedUrnNoQuery = decodedUrnFull.split('?')[0];
    const lineageUrnNoQuery = decodedUrnNoQuery
        .replace(':fs.file:vf.', ':dm.lineage:')
        .replace(':fs.file:v.', ':dm.lineage:');

    const position = stamp.accPosition || stamp.position || { x: 0, y: 0, z: 0 };
    const positionInt = {
        x: Math.round(Number(position.x) || 0),
        y: Math.round(Number(position.y) || 0),
        z: Math.round(Number(position.z) || 0)
    };

    const createdAtVersion = extractVersionNumber(decodedUrnFull, stamp.version);
    const viewName = (stamp.viewName && String(stamp.viewName).trim()) ? String(stamp.viewName) : 'ELIN Plan Prüfung';
    const issueType = stamp.type === 'mangel' ? 'mangel' : 'allgemein';

    const issuePayload = {
        title: stamp.title || `ELIN: ${stamp.stampKey || 'Stempel'}`,
        // Keep fallback issues visible in ACC issue lists (many lists default to open only).
        status: 'open',
        issueSubtypeId: issueType === 'mangel' ? SUBTYPE_ID_MANGEL : SUBTYPE_ID_ALLGEMEIN,
        description: [
            'Fallback: Markups-Endpoint in diesem Tenant nicht verfuegbar (404).',
            stamp.stampKey ? `StampKey: ${stamp.stampKey}` : null,
            stamp.stampLabel ? `StampLabel: ${stamp.stampLabel}` : null
        ].filter(Boolean).join(' | '),
        linkedDocuments: [
            {
                type: 'TwoDVectorPushpin',
                urn: lineageUrnNoQuery,
                createdAtVersion,
                details: {
                    viewable: {
                        id: stamp.viewId,
                        name: viewName,
                        is3D: false
                    },
                    position: {
                        x: positionInt.x,
                        y: positionInt.y
                    }
                }
            }
        ]
    };

    const response = await fetch(`https://developer.api.autodesk.com/construction/issues/v1/projects/${PROJECT_ID}/issues`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(issuePayload)
    });

    const text = await response.text();
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        parsed = { raw: text };
    }

    if (response.ok) {
        return {
            ok: true,
            issue: parsed,
            warning: null
        };
    }

    // ACC can create the issue but fail the annotation/markup attachment.
    // In that case metadata.issueId exists and we should not fail the whole request.
    if (parsed && parsed.errorCode === 'ISSUES_SERVICE_FAILED_TO_UPDATE_MARKUPS' && parsed.metadata && parsed.metadata.issueId) {
        const issueId = parsed.metadata.issueId;
        const issueLookup = await getIssueById({ token, projectId: PROJECT_ID, issueId });

        if (!issueLookup.exists) {
            throw new Error(
                `Issues-Fallback meldete issueId=${issueId}, aber das Issue ist nicht abrufbar `
                + `(${issueLookup.status} ${issueLookup.statusText}). `
                + `Die Anlage wurde vermutlich serverseitig verworfen.`
            );
        }

        const issue = issueLookup.issue || { id: issueId, displayId: issueId };
        return {
            ok: true,
            issue,
            warning: 'Issue erstellt, aber ACC konnte das Markup nicht einbetten.'
        };
    }

    throw new Error(`Issues-Fallback fehlgeschlagen (${response.status} ${response.statusText}): ${text}`);
}

function parseViewBox(viewBox) {
    const fallback = { minX: 0, minY: 0, width: 100, height: 100 };
    if (!viewBox) return fallback;

    const parts = String(viewBox).trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return fallback;

    const width = Math.abs(parts[2]) || 100;
    const height = Math.abs(parts[3]) || 100;
    return { minX: parts[0], minY: parts[1], width, height };
}

function buildPlacedStampSvg(stamp) {
    const fragment = (stamp.stampSvg || '').trim();
    if (!fragment) {
        throw new Error(`Stamp ${stamp.id || ''} hat kein SVG-Fragment (stampSvg).`);
    }

    const pos = stamp.accPosition || stamp.position || { x: 0, y: 0 };
    const x = Math.round(Number(pos.x) || 0);
    const y = Math.round(Number(pos.y) || 0);
    const scale = Number.isFinite(Number(stamp.scale)) ? Math.max(0.01, Number(stamp.scale)) : 1;
    const vb = parseViewBox(stamp.stampViewBox);

    const centerX = vb.minX + (vb.width / 2);
    const centerY = vb.minY + (vb.height / 2);
    const pad = 20;
    const outWidth = Math.max(1, vb.width * scale + (pad * 2));
    const outHeight = Math.max(1, vb.height * scale + (pad * 2));
    const outMinX = x - (outWidth / 2);
    const outMinY = y - (outHeight / 2);

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${outMinX} ${outMinY} ${outWidth} ${outHeight}"><g transform="translate(${x} ${y}) scale(${scale}) translate(${-centerX} ${-centerY})">${fragment}</g></svg>`;
}

async function postMarkupToAcc({ token, versionUrn, svgString, title }) {
    const endpoints = buildMarkupEndpointCandidates(versionUrn);
    const requestBodies = [
        {
            versionUrn,
            markup: {
                svgString,
                label: title || 'ELIN Stempel'
            }
        },
        {
            versionUrn,
            svg: svgString,
            title: title || 'ELIN Stempel',
            mimeType: 'image/svg+xml'
        }
    ];

    let lastError = null;

    for (const endpoint of endpoints) {
        for (const body of requestBodies) {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            const text = await response.text();
            if (response.ok) {
                let parsed = null;
                try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
                return { ok: true, payload: parsed, endpoint };
            }

            let parsedError = null;
            try { parsedError = JSON.parse(text); } catch (e) { parsedError = { message: text }; }
            lastError = {
                endpoint,
                status: response.status,
                statusText: response.statusText,
                body: parsedError,
                sentBody: body,
                triedEndpoints: endpoints
            };

            // For auth failures, do not continue probing other endpoints.
            if (response.status === 401 || response.status === 403) {
                return { ok: false, error: lastError };
            }
        }
    }

    return { ok: false, error: lastError };
}

async function postContainerMarkup({ token, projectId, stamp, issueId, issuesContainerId }) {
    const versionUrn = resolveVersionUrn(stamp);
    const containerId = (stamp.containerId && String(stamp.containerId).trim())
        || (stamp.issuesContainerId && String(stamp.issuesContainerId).trim())
        || (issuesContainerId && String(issuesContainerId).trim())
        || (stamp.itemId ? String(stamp.itemId).split(':').pop() : '');
    const svg = stamp.accMarkupSvg || '';

    if (!versionUrn || !containerId || !svg) {
        return { ok: false, skipped: true, reason: 'missing versionUrn/containerId/accMarkupSvg' };
    }

    const endpoint = `https://developer.api.autodesk.com/construction/markups/v1/projects/${projectId}/containers/${encodeURIComponent(containerId)}/markups`;
    const requestBodies = [
        {
            versionUrn,
            issueId,
            markup: {
                svg: svg,
                viewBox: stamp.stampViewBox || null,
                width: Number(stamp.stampWidth) || null,
                height: Number(stamp.stampHeight) || null,
                position: stamp.accPosition || stamp.accNormalizedPosition || { x: 0, y: 0, z: 0 },
                normalizedPosition: stamp.accNormalizedPosition || null,
                scale: Number(stamp.scale) || 1,
                viewId: stamp.viewId || null
            }
        },
        {
            versionUrn,
            issueId,
            svg,
            position: stamp.accPosition || stamp.accNormalizedPosition || { x: 0, y: 0, z: 0 },
            normalizedPosition: stamp.accNormalizedPosition || null,
            scale: Number(stamp.scale) || 1,
            viewId: stamp.viewId || null
        }
    ];

    let lastError = null;
    for (const body of requestBodies) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const text = await response.text();
        if (response.ok) {
            let parsed = null;
            try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
            return { ok: true, endpoint, markup: parsed };
        }

        let parsedError = null;
        try { parsedError = JSON.parse(text); } catch (e) { parsedError = { message: text }; }
        lastError = { endpoint, status: response.status, statusText: response.statusText, body: parsedError };

        if (response.status === 401 || response.status === 403) {
            return { ok: false, error: lastError };
        }
    }

    return { ok: false, error: lastError };
}

let app = express();
app.use(express.static('wwwroot'));
app.use(session({ secret: SERVER_SESSION_SECRET, maxAge: 24 * 60 * 60 * 1000 }));
app.use(express.json()); 

app.use(require('./routes/auth.js'));
app.use(require('./routes/hubs.js'));
app.get('/api/debug/build', (req, res) => {
    res.json({ build: SERVER_BUILD, port: PORT });
});
app.get('/api/debug/types', async (req, res) => {
    const token = req.session.internal_token;
    const projectId = PROJECT_ID;

    try {
        // WICHTIG: Wir hängen ?include=subtypes an, um die Unter-IDs zu sehen!
        const apiUrl = `https://developer.api.autodesk.com/construction/issues/v1/projects/${projectId}/issue-types?include=subtypes`;
        
        const response = await fetch(apiUrl, { 
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        const data = await response.json();
        let html = "<h2>Suche die roten IDs für deine Stempel:</h2>";
        
        data.results.forEach(type => {
            html += `<div style="margin-bottom:20px; border:1px solid #ccc; padding:10px;">`;
            html += `<b>Kategorie: ${type.title}</b> (Type-ID: ${type.id})<br><ul>`;
            
            type.subtypes.forEach(sub => {
                html += `<li>Unterkategorie: <b>${sub.title}</b><br>ID (DIESE NUTZEN!): <code style="color:red;">${sub.id}</code></li>`;
            });
            html += `</ul></div>`;
        });
        
        res.send(html);
    } catch(e) {
        res.send("Fehler: " + e.message);
    }
});

app.get('/api/issues/types', async (req, res) => {
    try {
        const token = req.session.internal_token;
        if (!token) throw new Error('Kein Benutzer-Token gefunden. Bitte neu einloggen.');

        const reqProjectIdRaw = String(req.query.projectId || '').trim();
        const projectId = normalizeProjectId(reqProjectIdRaw) || PROJECT_ID;

        const catalog = await fetchIssueTypeCatalog({ token, projectId });
        if (!catalog.ok) throw new Error(catalog.error);

        const options = [];
        const results = Array.isArray(catalog.results) ? catalog.results : [];
        for (const type of results) {
            const typeTitle = type && type.title ? String(type.title) : 'Typ';
            const subtypes = Array.isArray(type && type.subtypes) ? type.subtypes : [];
            for (const sub of subtypes) {
                if (!sub || !sub.id) continue;
                if (!isActiveSubtype(sub)) continue;
                const subtypeTitle = sub.title ? String(sub.title) : String(sub.id);
                options.push({
                    value: String(sub.id),
                    label: `${typeTitle} / ${subtypeTitle}`,
                    typeTitle,
                    subtypeTitle
                });
            }
        }

        res.json({
            projectId,
            options,
            defaultSubtypeId: catalog.firstActiveSubtypeId || null
        });
    } catch (err) {
        console.error('Fehler beim Laden der Issue-Typen:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/hubs/:hubId/projects/:projectId/issuetypes', async (req, res) => {
    try {
        const token = req.session.internal_token;
        if (!token) throw new Error('Kein Benutzer-Token gefunden. Bitte neu einloggen.');

        const hubId = normalizeHubId(req.params.hubId);
        const projectIdRaw = normalizeProjectIdWithPrefix(req.params.projectId);
        const projectId = normalizeProjectId(projectIdRaw);

        const catalog = await fetchIssueTypeCatalog({ token, projectId });
        if (!catalog.ok) throw new Error(catalog.error);

        const options = [];
        const results = Array.isArray(catalog.results) ? catalog.results : [];
        for (const type of results) {
            const typeTitle = type && type.title ? String(type.title) : 'Typ';
            const subtypes = Array.isArray(type && type.subtypes) ? type.subtypes : [];
            for (const sub of subtypes) {
                if (!sub || !sub.id) continue;
                if (!isActiveSubtype(sub)) continue;
                const subtypeTitle = sub.title ? String(sub.title) : String(sub.id);
                options.push({
                    value: String(sub.id),
                    label: `${typeTitle} / ${subtypeTitle}`,
                    isActive: true,
                    typeTitle,
                    subtypeTitle
                });
            }
        }

        res.json({
            hubId,
            projectId: projectIdRaw,
            options,
            defaultSubtypeId: catalog.firstActiveSubtypeId || null
        });
    } catch (err) {
        console.error('Fehler beim Laden der Hub/Projekt Issue-Typen:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/issues/create', async (req, res) => {
    try {
        console.log(`🚀 /api/issues/create build=${SERVER_BUILD}`);
        const stampsData = Array.isArray(req.body.stamps) ? req.body.stamps : [];
        const token = req.session.internal_token; 
        if (!token) throw new Error("Kein Benutzer-Token gefunden. Bitte neu einloggen.");
        if (stampsData.length === 0) throw new Error('Keine Stempel-Daten erhalten (stamps ist leer).');

        const reqProjectIdRaw = String(req.body.projectId || '').trim();
        const stampProjectIdRaw = String((stampsData[0] && stampsData[0].projectId) || '').trim();
        const reqProjectId = normalizeProjectId(reqProjectIdRaw);
        const stampProjectId = normalizeProjectId(stampProjectIdRaw);
        const reqHubId = normalizeHubId(req.body.hubId);
        const stampHubId = normalizeHubId(stampsData[0] && stampsData[0].hubId);
        const targetHubId = reqHubId || stampHubId || '';
        const targetProjectId = reqProjectId || stampProjectId || PROJECT_ID;
        const targetProjectIdForProjectApi = normalizeProjectIdWithPrefix(reqProjectIdRaw || stampProjectIdRaw || targetProjectId);

        if (!targetHubId || !targetProjectIdForProjectApi) {
            return res.status(400).json({
                success: false,
                message: 'hubId/projectId fehlen fuer den ACC Project-Lookup. Bitte im Sidebar-Baum Projektkontext auswaehlen.'
            });
        }

        console.log('📌 /api/issues/create targetProjectId:', {
            reqHubId,
            stampHubId,
            targetHubId,
            reqProjectIdRaw,
            stampProjectIdRaw,
            targetProjectIdForProjectApi,
            reqProjectId,
            stampProjectId,
            fallbackProjectId: PROJECT_ID,
            targetProjectId
        });

        const containerLookup = await fetchIssuesContainerId({ token, hubId: targetHubId, projectId: targetProjectIdForProjectApi });
        const issuesContainerId = containerLookup && containerLookup.issuesContainerId
            ? String(containerLookup.issuesContainerId)
            : '';

        if (issuesContainerId) {
            console.log('📦 Resolved issuesContainerId:', {
                targetProjectId,
                issuesContainerId,
                sourceUrl: containerLookup.url,
                hubIdUsed: containerLookup.hubIdUsed,
                projectIdUsed: containerLookup.projectIdUsed
            });
        } else {
            console.warn('⚠️ issuesContainerId konnte nicht aufgeloest werden (2D Pushpin kann tenant-abhaengig fehlschlagen):', {
                targetProjectId,
                lookup: containerLookup
            });
        }

        const typeCatalog = await fetchIssueTypeCatalog({ token, projectId: targetProjectId });
        const activeSubtypeIds = typeCatalog.ok ? typeCatalog.activeSubtypeIds : new Set();
        const defaultActiveSubtypeId = typeCatalog.ok ? (typeCatalog.firstActiveSubtypeId || '') : '';
        if (!typeCatalog.ok) {
            console.warn('⚠️ Konnte aktive Subtypes nicht vorab laden. Fallback auf statische IDs.', {
                projectId: targetProjectId,
                error: typeCatalog.error
            });
        }
        
        const createdIssues = [];

        for (const stamp of stampsData) {
            // URN Dekodieren: Von dXJu... (Base64) zu urn:adsk... (Klartext)
            const rawOriginalUrn = stamp.originalUrn || stamp.urn || stamp.versionUrn || '';
            let decodedUrnFull = decodeAutodeskUrn(rawOriginalUrn);
            if (!decodedUrnFull) {
                throw new Error(`Stamp ${stamp.id || ''}: originalUrn fehlt im Payload.`);
            }
            const decodedUrnNoQuery = decodedUrnFull.split('?')[0];

            console.log('📋 Processing stamp:', {
                id: stamp.id,
                stampKey: stamp.stampKey,
                linkedType: stamp.linkedDocumentType,
                is3D: stamp.is3D,
                viewId: stamp.viewId,
                originalUrn: stamp.urn,
                decodedUrnFull,
                decodedUrnNoQuery
            });

            // ACC verlangt oft das dm.lineage Format
            const lineageUrnNoQuery = decodedUrnNoQuery.replace(':fs.file:vf.', ':dm.lineage:').replace(':fs.file:v.', ':dm.lineage:').split('?')[0];
            const resolvedVersionUrn = resolveVersionUrn(stamp);
            const decodedVersionUrn = decodeAutodeskUrn(stamp.versionUrn || '');
            const providedLinkedUrn = decodeAutodeskUrn(stamp.linkedDocumentUrn || '').split('?')[0]
                .replace(':fs.file:vf.', ':dm.lineage:')
                .replace(':fs.file:v.', ':dm.lineage:');

            const requestedType = stamp.linkedDocumentType || (stamp.is3D ? 'ThreeDVectorPushpin' : 'TwoDVectorPushpin');
            const is3D = requestedType === 'ThreeDVectorPushpin' || !!stamp.is3D;
            const is2D = !is3D;

            const linkedUrnCandidates2D = uniqueNonEmpty([
                providedLinkedUrn,
                lineageUrnNoQuery
            ]).filter((u) => isLineageUrn(u));

            if (is2D && linkedUrnCandidates2D.length === 0) {
                throw new Error(`Stamp ${stamp.id || ''}: keine gueltige dm.lineage URN ableitbar (linkedDocumentUrn=${stamp.linkedDocumentUrn || ''}, urn=${stamp.urn || ''}).`);
            }

            const pushpinPos = is2D
                ? (stamp.accNormalizedPosition || stamp.accPosition || stamp.dbWorld || stamp.worldPosition || stamp.position || { x: 0, y: 0, z: 0 })
                : (stamp.accPosition || stamp.dbWorld || stamp.worldPosition || stamp.position || { x: 0, y: 0, z: 0 });
            const viewName = (stamp.viewName && String(stamp.viewName).trim()) ? String(stamp.viewName) : 'ELIN Plan Prüfung';
            const createdAtVersion = parseVersionFromVersionUrn(stamp.versionUrn || stamp.urn, stamp.version);
            const subtypeCandidate = stamp.issueSubtypeId ? String(stamp.issueSubtypeId) : '';
            const hasSubtypeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subtypeCandidate);

            // Keep precision from viewer coordinates.
            const positionPrecise = {
                x: Number.isFinite(Number(pushpinPos.x)) ? Number(pushpinPos.x) : 0,
                y: Number.isFinite(Number(pushpinPos.y)) ? Number(pushpinPos.y) : 0,
                z: Number.isFinite(Number(pushpinPos.z)) ? Number(pushpinPos.z) : 0
            };

            const basePayload = {
                title: (stamp.title || 'ELIN Stempel').replace('Ã¼', 'ü'),
                // Keep newly created issues visible in ACC lists.
                status: 'open',
                issueSubtypeId: (() => {
                    const fallbackSubtype = stamp.type === 'mangel' ? SUBTYPE_ID_MANGEL : SUBTYPE_ID_ALLGEMEIN;
                    if (hasSubtypeUuid && activeSubtypeIds.has(subtypeCandidate)) return subtypeCandidate;
                    if (defaultActiveSubtypeId) return defaultActiveSubtypeId;
                    if (hasSubtypeUuid) return subtypeCandidate;
                    return fallbackSubtype;
                })(),
                description: [
                    stamp.stampKey ? `StampKey: ${stamp.stampKey}` : null,
                    stamp.stampLabel ? `StampLabel: ${stamp.stampLabel}` : null,
                    (typeof stamp.scale === 'number') ? `Scale: ${stamp.scale}` : null
                ].filter(Boolean).join(' | ') || undefined
            };

            const sendIssueProject = async (payload) => {
                console.log('📤 Sending to ACC API:', JSON.stringify(payload, null, 2));
                const response = await fetch(`https://developer.api.autodesk.com/construction/issues/v1/projects/${targetProjectId}/issues`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });
                const responseText = await response.text();
                let parsedBody = null;
                try { parsedBody = JSON.parse(responseText); } catch (e) { /* ignore */ }
                const parsedError = response.ok ? null : parsedBody;
                return { response, responseText, parsedBody, parsedError, requestPayload: payload };
            };

            const sendIssueViaContainer = async (payload) => {
                if (!issuesContainerId) {
                    return null;
                }
                const endpoint = `https://developer.api.autodesk.com/issues/v1/containers/${encodeURIComponent(issuesContainerId)}/issues`;
                console.log('📤 Sending to ACC Container API (fallback):', JSON.stringify({ endpoint, payload }, null, 2));
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });

                const responseText = await response.text();
                let parsedBody = null;
                try { parsedBody = JSON.parse(responseText); } catch (e) { /* ignore */ }
                const parsedError = response.ok ? null : parsedBody;
                return {
                    response,
                    responseText,
                    parsedBody,
                    parsedError,
                    requestPayload: payload,
                    endpoint
                };
            };

            const sendIssue = async (payload) => {
                if (issuesContainerId) {
                    const byContainer = await sendIssueViaContainer(payload);
                    if (byContainer && byContainer.response && byContainer.response.ok) {
                        return byContainer;
                    }
                    if (byContainer) {
                        console.warn('⚠️ Container-Issue-Endpoint abgelehnt, fallback auf project endpoint.', {
                            endpoint: byContainer.endpoint,
                            status: byContainer.response.status,
                            statusText: byContainer.response.statusText,
                            autodeskError: byContainer.parsedError || byContainer.responseText,
                            issuesContainerId
                        });
                    }
                }
                return sendIssueProject(payload);
            };

            const detailToText = (details) => {
                if (!details) return '';
                if (typeof details === 'string') return details;
                if (Array.isArray(details)) {
                    return details.map((d) => {
                        const m = d && d.message ? d.message : '';
                        const p = d && Array.isArray(d.path) ? d.path.join('.') : '';
                        return `${m}${p ? ` @ ${p}` : ''}`.trim();
                    }).filter(Boolean).join(' | ');
                }
                return JSON.stringify(details);
            };

            const payload2D = {
                ...basePayload,
                linkedDocuments: [
                    {
                        type: 'TwoDVectorPushpin',
                        urn: lineageUrnNoQuery,
                        createdAtVersion,
                        details: {
                            viewable: {
                                id: stamp.viewId,
                                name: viewName,
                                is3D: false
                            },
                            position: {
                                x: positionPrecise.x,
                                y: positionPrecise.y
                            }
                        }
                    }
                ]
            };

            const buildPayload2DForUrn = (urnValue) => ({
                ...basePayload,
                linkedDocuments: [
                    {
                        type: 'TwoDVectorPushpin',
                        urn: urnValue,
                        createdAtVersion,
                        details: {
                            viewable: {
                                id: stamp.viewId,
                                name: viewName,
                                is3D: false
                            },
                            position: {
                                x: positionPrecise.x,
                                y: positionPrecise.y
                            }
                        }
                    }
                ]
            });

            const payload3DPrimary = {
                ...basePayload,
                linkedDocuments: [
                    {
                        type: 'ThreeDVectorPushpin',
                        urn: lineageUrnNoQuery,
                        createdAtVersion,
                        details: {
                            viewable: {
                                id: stamp.viewId,
                                name: viewName,
                                is3D: true
                            },
                            position: positionPrecise
                        }
                    }
                ]
            };

            // Fallback für Tenants/Schema, die ThreeDVectorPushpin nicht akzeptieren.
            const payload3DFallback = {
                ...basePayload,
                linkedDocuments: [
                    {
                        type: 'TwoDVectorPushpin',
                        urn: lineageUrnNoQuery,
                        createdAtVersion,
                        details: {
                            viewable: {
                                id: stamp.viewId,
                                name: viewName,
                                is3D: true
                            },
                            position: positionPrecise
                        }
                    }
                ]
            };

            let result = null;

            if (is2D) {
                const attempts = linkedUrnCandidates2D.length > 0 ? linkedUrnCandidates2D : [lineageUrnNoQuery];
                for (let i = 0; i < attempts.length; i++) {
                    const urnCandidate = attempts[i];
                    const payloadCandidate = buildPayload2DForUrn(urnCandidate);
                    result = await sendIssue(payloadCandidate);

                    if (result.response.ok) {
                        if (i > 0) {
                            console.log('✅ 2D Pushpin akzeptiert mit URN-Fallback:', { urnCandidate, attempt: i + 1, attempts: attempts.length });
                        }
                        break;
                    }

                    console.error('❌ 2D Pushpin Versuch fehlgeschlagen:', {
                        attempt: i + 1,
                        attempts: attempts.length,
                        urnCandidate,
                        status: result.response.status,
                        statusText: result.response.statusText,
                        autodeskError: result.parsedError || result.responseText,
                        requestPayload: payloadCandidate,
                        issuesContainerId
                    });
                }

                if (result && !result.response.ok && issuesContainerId) {
                    const fallbackPayload = buildPayload2DForUrn(attempts[0]);
                    const containerResult = await sendIssueViaContainer(fallbackPayload);
                    if (containerResult) {
                        if (containerResult.response.ok) {
                            console.log('✅ 2D Pushpin akzeptiert ueber Container-Fallback-Endpoint:', {
                                endpoint: containerResult.endpoint,
                                issuesContainerId
                            });
                            result = containerResult;
                        } else {
                            console.error('❌ Container-Fallback fuer 2D Pushpin fehlgeschlagen:', {
                                endpoint: containerResult.endpoint,
                                issuesContainerId,
                                status: containerResult.response.status,
                                statusText: containerResult.response.statusText,
                                autodeskError: containerResult.parsedError || containerResult.responseText,
                                requestPayload: fallbackPayload
                            });
                        }
                    }
                }
            } else {
                result = await sendIssue(payload3DPrimary);
            }

            // Keep the original default around for code paths below.
            if (!result) {
                result = await sendIssue(is2D ? payload2D : payload3DPrimary);
            }

            if (!result.response.ok && !is2D) {
                const e = result.parsedError || {};
                const enumRejected = e.errorCode === 'ISSUES_SERVICE_BAD_REQUEST'
                    && Array.isArray(e.details)
                    && e.details.some((d) => d && d.message && String(d.message).includes('allowed values')
                        && d.context && d.context.value === 'ThreeDVectorPushpin');

                if (enumRejected) {
                    console.warn('⚠️ ThreeDVectorPushpin wird von diesem ACC-Schema abgelehnt, versuche TwoDVectorPushpin-Fallback für 3D.');
                    result = await sendIssue(payload3DFallback);
                }
            }

            if (result.response.ok) {
                const accIssue = result.parsedBody || JSON.parse(result.responseText);
                const markupResult = await postContainerMarkup({
                    token,
                    projectId: targetProjectId,
                    stamp,
                    issuesContainerId,
                    issueId: accIssue.id || accIssue.displayId
                });

                if (markupResult.ok) {
                    accIssue.markup = markupResult.markup;
                } else if (!markupResult.skipped) {
                    accIssue.warning = 'Issue erstellt, aber SVG-Markup konnte nicht geschrieben werden.';
                    accIssue.markupError = markupResult.error;
                    console.warn('⚠️ Markup POST fehlgeschlagen:', JSON.stringify(markupResult.error));
                }

                createdIssues.push(accIssue);
                console.log(`✅ Aufgabe in ACC erstellt: ${accIssue.displayId}`);
                continue;
            }

            const errorCode = result.parsedError && result.parsedError.errorCode ? result.parsedError.errorCode : null;
            const detail = detailToText(result.parsedError ? result.parsedError.details : '');

            console.error('❌ ACC Pushpin/Issue Fehlerdetails:', {
                status: result.response.status,
                statusText: result.response.statusText,
                errorCode,
                detail,
                autodeskError: result.parsedError || result.responseText,
                requestPayload: result.requestPayload,
                issuesContainerId,
                targetProjectId
            });

            if (result.response.status === 401 || errorCode === 'AUTH-006') {
                throw new Error('ACC Token ist abgelaufen oder ungültig (AUTH-006). Bitte neu einloggen und erneut senden.');
            }

            if (errorCode === 'ISSUES_SERVICE_FAILED_TO_UPDATE_MARKUPS' && result.parsedError && result.parsedError.metadata && result.parsedError.metadata.issueId) {
                const issueId = result.parsedError.metadata.issueId;
                
                // Retry issue creation without linkedDocuments so issue list still gets entry.
                const pureIssuePayload = {
                    ...basePayload
                };

                const pureIssueResult = await sendIssue(pureIssuePayload);
                if (pureIssueResult.response.ok) {
                    const issue = JSON.parse(pureIssueResult.responseText);
                    const markupResult = await postContainerMarkup({
                        token,
                        projectId: targetProjectId,
                        stamp,
                        issuesContainerId,
                        issueId: issue.id || issue.displayId
                    });

                    createdIssues.push({
                        ...issue,
                        warning: markupResult.ok
                            ? 'Issue ohne Pushpin erstellt, SVG-Markup separat angelegt.'
                            : 'Issue ohne Pushpin erstellt (ACC Markup-Anlage fehlgeschlagen).',
                        markup: markupResult.ok ? markupResult.markup : undefined,
                        markupError: (!markupResult.ok && !markupResult.skipped) ? markupResult.error : undefined
                    });
                    console.warn('⚠️ Pushpin fehlgeschlagen, aber Issue ohne linkedDocuments erstellt:', issue.displayId || issue.id);
                    continue;
                }

                const lookup = await getIssueById({ token, projectId: targetProjectId, issueId });

                if (!lookup.exists) {
                    throw new Error(`ACC meldet issueId=${issueId}, aber das Issue ist im Projekt nicht abrufbar (${lookup.status} ${lookup.statusText}).`);
                }

                const verifiedIssue = lookup.issue || { id: issueId, displayId: issueId };
                createdIssues.push({
                    ...verifiedIssue,
                    warning: 'Issue erstellt, aber Markup konnte nicht platziert werden.'
                });
                console.warn('⚠️ Issue erstellt, aber Markup fehlgeschlagen:', issueId, detail);
                continue;
            }

            let errorMsg = result.response.statusText;
            if (result.parsedError && result.parsedError.message) errorMsg = result.parsedError.message;
            if (detail) errorMsg += `: ${detail}`;
            throw new Error(`ACC API Error: ${errorMsg} | Raw: ${result.responseText}`);
        }

        const warningCount = createdIssues.filter((i) => i && i.warning).length;
        const successMsg = warningCount > 0
            ? `${createdIssues.length} Aufgaben erstellt (${warningCount} ohne 2D-Markup).`
            : `${createdIssues.length} Aufgaben erfolgreich erstellt!`;

        res.status(200).json({ success: true, message: successMsg, createdIssues, build: SERVER_BUILD });

    } catch (err) {
        console.error("Fehler beim Erstellen der ACC Issues:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/markups/create', async (req, res) => {
    try {
        console.log(`🚀 /api/markups/create build=${SERVER_BUILD}`);
        const stampsData = Array.isArray(req.body.stamps) ? req.body.stamps : [];
        const token = req.session.internal_token;
        if (!token) throw new Error('Kein Benutzer-Token gefunden. Bitte neu einloggen.');
        if (stampsData.length === 0) throw new Error('Keine Stempel-Daten erhalten (stamps ist leer).');

        const createdMarkups = [];
        let fallbackIssueCount = 0;
        let warningCount = 0;

        for (const stamp of stampsData) {
            const versionUrn = resolveVersionUrn(stamp);
            if (!versionUrn) {
                throw new Error(`Stamp ${stamp.id || ''}: versionUrn konnte nicht bestimmt werden.`);
            }

            const svgString = buildPlacedStampSvg(stamp);
            const title = stamp.title || `ELIN: ${stamp.stampKey || 'Stempel'}`;

            const result = await postMarkupToAcc({ token, versionUrn, svgString, title });
            if (!result.ok) {
                if (result.error && result.error.status === 404) {
                    const fallbackResult = await createIssuePushpinFallback({ token, stamp });
                    const issue = fallbackResult.issue;
                    fallbackIssueCount += 1;
                    if (fallbackResult.warning) warningCount += 1;
                    createdMarkups.push({
                        stampId: stamp.id,
                        versionUrn,
                        title,
                        fallback: 'issues-v1-pushpin',
                        warning: fallbackResult.warning || null,
                        issue
                    });
                    continue;
                }

                const errorText = JSON.stringify(result.error && result.error.body ? result.error.body : result.error);
                throw new Error(`Markups API Fehler [${result.error.endpoint}] (${result.error.status} ${result.error.statusText}): ${errorText}`);
            }

            createdMarkups.push({
                stampId: stamp.id,
                versionUrn,
                title,
                endpoint: result.endpoint,
                markup: result.payload
            });
        }

        res.status(200).json({
            success: true,
            message: fallbackIssueCount > 0
                ? (warningCount > 0
                    ? `${createdMarkups.length} Element(e) erstellt (${fallbackIssueCount} via Issues-Fallback, ${warningCount} ohne eingebettetes Markup).`
                    : `${createdMarkups.length} Element(e) erstellt (${fallbackIssueCount} via Issues-Fallback mit dauerhaftem 2D-Pushpin).`)
                : `${createdMarkups.length} Markup(s) erfolgreich in ACC erstellt.`,
            endpoint: createdMarkups[0] ? createdMarkups[0].endpoint : null,
            fallbackIssueCount,
            warningCount,
            createdMarkups,
            build: SERVER_BUILD
        });
    } catch (err) {
        console.error('Fehler beim Erstellen von ACC Markups:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}...`));