const express = require('express');
const session = require('cookie-session');
const fs = require('fs');
const path = require('path');
const { PORT, SERVER_SESSION_SECRET } = require('./config.js');
const SERVER_BUILD = '2026-03-04-2d-markup-stable';
const ACC_MARKUPS_POST_URL = process.env.ACC_MARKUPS_POST_URL || '';
const MARKUPS_UNAVAILABLE_CACHE = new Set();
const STAMPS_DATA_DIR = path.join(__dirname, 'data', 'stamps');

function storageKeyToFileName(key) {
    const normalized = String(key || '').trim();
    if (!normalized) return '';
    const encoded = Buffer.from(normalized, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return `${encoded}.json`;
}

async function ensureStampsDataDir() {
    await fs.promises.mkdir(STAMPS_DATA_DIR, { recursive: true });
}

function parseBooleanFlag(value, fallback = false) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const s = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    return fallback;
}

function parseClampDecimalsFlag(value, fallback = -1) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return fallback;
    if (parsed < -1) return -1;
    return Math.min(parsed, 10);
}

const USE_2D_VECTOR_PIN = parseBooleanFlag(process.env.USE_2D_VECTOR_PIN, false);
const CLAMP_POS_DECIMALS = parseClampDecimalsFlag(process.env.CLAMP_POS_DECIMALS, -1);
const ENABLE_CONTAINER_MARKUP_POST = parseBooleanFlag(process.env.ENABLE_CONTAINER_MARKUP_POST, true);
const ISSUE_2D_LINKED_DOC_TYPE = USE_2D_VECTOR_PIN ? 'TwoDVectorPushpin' : 'TwoDRasterPushpin';
let RUNTIME_PREFERRED_2D_LINKED_DOC_TYPE = ISSUE_2D_LINKED_DOC_TYPE;

function sanitizePosition(position) {
    const asNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    const clamp = (n) => {
        if (CLAMP_POS_DECIMALS < 0) return n;
        return Number.parseFloat(Number(n).toFixed(CLAMP_POS_DECIMALS));
    };

    return {
        x: clamp(asNumber(position && position.x)),
        y: clamp(asNumber(position && position.y)),
        z: clamp(asNumber(position && position.z))
    };
}

console.log('⚙️ ACC flags:', {
    USE_2D_VECTOR_PIN,
    CLAMP_POS_DECIMALS,
    ENABLE_CONTAINER_MARKUP_POST,
    ISSUE_2D_LINKED_DOC_TYPE
});

function getAlt2DLinkedDocType(type) {
    return type === 'TwoDVectorPushpin' ? 'TwoDRasterPushpin' : 'TwoDVectorPushpin';
}

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
    if (!payload || typeof payload !== 'object') return { id: '', source: 'none' };

    const data = payload.data || {};
    const attrs = data.attributes || {};
    const extData = attrs.extension && attrs.extension.data ? attrs.extension.data : {};
    const relationships = data.relationships || {};

    // Primary source according to Autodesk project response.
    const issuesRel = relationships.issues || {};
    const issuesRelData = issuesRel.data;
    if (Array.isArray(issuesRelData)) {
        const first = issuesRelData.find((x) => x && x.id);
        if (first && first.id) return { id: String(first.id).trim(), source: 'data.relationships.issues.data[0].id' };
    }
    if (issuesRelData && issuesRelData.id) {
        return { id: String(issuesRelData.id).trim(), source: 'data.relationships.issues.data.id' };
    }

    // Alternative relationship naming variants.
    const issuesContainer = relationships.issuesContainer || relationships.issueContainer || {};
    const relData = issuesContainer.data || {};
    if (relData.id) return { id: String(relData.id).trim(), source: 'data.relationships.issuesContainer.data.id' };

    // Secondary source for older BIM360-style payloads.
    if (extData.projectGuid) return { id: String(extData.projectGuid).trim(), source: 'data.attributes.extension.data.projectGuid' };
    if (extData.issuesContainerId) return { id: String(extData.issuesContainerId).trim(), source: 'data.attributes.extension.data.issuesContainerId' };

    // Tertiary compatibility sources.
    if (attrs.issuesContainerId) return { id: String(attrs.issuesContainerId).trim(), source: 'data.attributes.issuesContainerId' };
    if (payload.issuesContainerId) return { id: String(payload.issuesContainerId).trim(), source: 'payload.issuesContainerId' };
    if (payload.issueContainerId) return { id: String(payload.issueContainerId).trim(), source: 'payload.issueContainerId' };

    return { id: '', source: 'none' };
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
            const responseData = parsed;

            console.log('📄 [ACC project lookup] URL/context:', {
                url,
                projectIdUsed: candidate.projectIdUsed,
                hubIdUsed: hubNormalized || null,
                responseStatus: response.status,
                responseStatusText: response.statusText
            });

            try {
                console.log('📄 [ACC project lookup] FULL RESPONSE BODY START');
                console.log(JSON.stringify(responseData, null, 2));
                console.log('📄 [ACC project lookup] FULL RESPONSE BODY END');
            } catch (stringifyErr) {
                console.warn('⚠️ [ACC project lookup] Could not stringify full response body:', stringifyErr && stringifyErr.message ? stringifyErr.message : stringifyErr);
                console.log('📄 [ACC project lookup] Raw text body fallback:', text);
            }

            try {
                const relationships = responseData && responseData.data && responseData.data.relationships
                    ? responseData.data.relationships
                    : null;
                console.log('📌 [ACC project lookup] responseData.data.relationships START');
                console.log(JSON.stringify(relationships, null, 2));
                console.log('📌 [ACC project lookup] responseData.data.relationships END');
            } catch (relErr) {
                console.warn('⚠️ [ACC project lookup] Could not stringify responseData.data.relationships:', relErr && relErr.message ? relErr.message : relErr);
            }

            try {
                const extensionData = responseData
                    && responseData.data
                    && responseData.data.attributes
                    && responseData.data.attributes.extension
                    && responseData.data.attributes.extension.data
                    ? responseData.data.attributes.extension.data
                    : null;
                console.log('📌 [ACC project lookup] responseData.data.attributes.extension.data START');
                console.log(JSON.stringify(extensionData, null, 2));
                console.log('📌 [ACC project lookup] responseData.data.attributes.extension.data END');
            } catch (extErr) {
                console.warn('⚠️ [ACC project lookup] Could not stringify responseData.data.attributes.extension.data:', extErr && extErr.message ? extErr.message : extErr);
            }

            const extracted = extractIssuesContainerId(responseData);
            const issuesContainerId = extracted.id;
            return {
                ok: true,
                issuesContainerId,
                issuesContainerSource: extracted.source,
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

function buildMarkupEndpointCandidates(versionUrn, projectId) {
    const normalizedProjectId = normalizeProjectId(projectId);
    if (!normalizedProjectId) {
        throw new Error('Strict Mode: projectId fehlt fuer Markup-Endpoint-Ermittlung.');
    }

    const encodedVersionUrn = encodeURIComponent(versionUrn);

    if (ACC_MARKUPS_POST_URL) {
        // Optional placeholders for env override:
        // {projectId}, {versionUrn}
        const expanded = ACC_MARKUPS_POST_URL
            .replaceAll('{projectId}', normalizedProjectId)
            .replaceAll('{versionUrn}', encodedVersionUrn);
        return [expanded];
    }

    // Fallback candidates (APS docs for markups changed over time).
    return [
        `https://developer.api.autodesk.com/construction/markups/v1/projects/${normalizedProjectId}/markups`,
        `https://developer.api.autodesk.com/construction/markups/v2/projects/${normalizedProjectId}/markups`,
        `https://developer.api.autodesk.com/construction/markups/v1/projects/${normalizedProjectId}/versions/${encodedVersionUrn}/markups`,
        `https://developer.api.autodesk.com/construction/markups/v2/projects/${normalizedProjectId}/versions/${encodedVersionUrn}/markups`
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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getIssueByIdWithRetry({ token, projectId, issueId, retries = 6, delayMs = 600 }) {
    let last = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        const lookup = await getIssueById({ token, projectId, issueId });
        last = lookup;
        if (lookup.exists) return { ...lookup, attempts: attempt };

        const status = Number(lookup.status || 0);
        const retryable = status === 404 || status === 429 || status >= 500;
        if (!retryable || attempt === retries) {
            return { ...lookup, attempts: attempt };
        }
        await sleep(delayMs);
    }
    return { ...(last || { exists: false }), attempts: retries };
}

async function createIssuePushpinFallback({ token, stamp, projectId }) {
    const normalizedProjectId = normalizeProjectId(projectId || stamp.projectId);
    if (!normalizedProjectId) {
        throw new Error('Strict Mode: projectId fehlt fuer createIssuePushpinFallback.');
    }

    const subtype = String(stamp.issueSubtypeId || '').trim();
    if (!subtype) {
        throw new Error('Strict Mode: issueSubtypeId fehlt im Fallback-Stamp-Payload.');
    }

    const decodedUrnFull = decodeAutodeskUrn(stamp.urn || stamp.versionUrn || '');
    const decodedUrnNoQuery = decodedUrnFull.split('?')[0];
    const lineageUrnNoQuery = decodedUrnNoQuery
        .replace(':fs.file:vf.', ':dm.lineage:')
        .replace(':fs.file:v.', ':dm.lineage:');

    const position = stamp.accNormalizedPosition || stamp.accPosition || stamp.position || { x: 0, y: 0, z: 0 };
    const positionPrecise = sanitizePosition(position);

    const createdAtVersion = (() => {
        const explicit = Number(stamp.createdAtVersion);
        if (Number.isInteger(explicit) && explicit > 0 && explicit < 1000) return explicit;
        const fromVersionId = String(stamp.versionId || '').match(/[?&]version=(\d+)/i);
        if (fromVersionId) {
            const parsed = parseInt(fromVersionId[1], 10);
            if (Number.isInteger(parsed) && parsed > 0 && parsed < 1000) return parsed;
        }
        return extractVersionNumber(decodedUrnFull, stamp.version);
    })();
    const viewName = (stamp.viewName && String(stamp.viewName).trim()) ? String(stamp.viewName) : 'ELIN Plan Prüfung';
    const issuePayload = {
        title: stamp.title || `ELIN: ${stamp.stampKey || 'Stempel'}`,
        // Keep fallback issues visible in ACC issue lists (many lists default to open only).
        status: 'open',
        issueSubtypeId: subtype,
        description: [
            'Fallback: Markups-Endpoint in diesem Tenant nicht verfuegbar (404).',
            stamp.stampKey ? `StampKey: ${stamp.stampKey}` : null,
            stamp.stampLabel ? `StampLabel: ${stamp.stampLabel}` : null
        ].filter(Boolean).join(' | '),
        linkedDocuments: [
            {
                type: ISSUE_2D_LINKED_DOC_TYPE,
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

    const response = await fetch(`https://developer.api.autodesk.com/construction/issues/v1/projects/${normalizedProjectId}/issues`, {
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
        const issueLookup = await getIssueByIdWithRetry({
            token,
            projectId: normalizedProjectId,
            issueId,
            retries: 6,
            delayMs: 600
        });

        if (!issueLookup.exists) {
            return {
                ok: true,
                issue: { id: issueId, displayId: issueId },
                warning: `Issue von ACC gemeldet (issueId=${issueId}), aber nach ${issueLookup.attempts || 1} Lookup-Versuchen noch nicht abrufbar (${issueLookup.status || 'n/a'} ${issueLookup.statusText || ''}).`
            };
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

async function postMarkupToAcc({ token, versionUrn, svgString, title, projectId }) {
    const endpoints = buildMarkupEndpointCandidates(versionUrn, projectId);
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
    const looksLikeContainerId = (value) => {
        const v = String(value || '').trim();
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    };

    const directIssuesContainerId = issuesContainerId && String(issuesContainerId).trim();
    const stampIssuesContainerId = stamp.issuesContainerId && String(stamp.issuesContainerId).trim();
    const stampContainerId = stamp.containerId && String(stamp.containerId).trim();
    const itemDerivedContainerId = stamp.itemId ? String(stamp.itemId).split(':').pop() : '';

    const containerId = directIssuesContainerId
        || stampIssuesContainerId
        || (looksLikeContainerId(stampContainerId) ? stampContainerId : '')
        || (looksLikeContainerId(itemDerivedContainerId) ? itemDerivedContainerId : '');
    const svg = stamp.accMarkupSvg || '';
    const markupCacheKey = `${normalizeProjectId(projectId)}::${containerId}`;

    console.log('🧩 postContainerMarkup input:', {
        issueId,
        projectId,
        resolvedVersionUrn: versionUrn,
        resolvedContainerId: containerId,
        sources: {
            directIssuesContainerId,
            stampIssuesContainerId,
            stampContainerId,
            itemDerivedContainerId
        },
        hasSvg: !!svg
    });

    if (!versionUrn || !containerId || !svg) {
        console.warn('⚠️ postContainerMarkup skipped:', {
            reason: 'missing versionUrn/containerId/accMarkupSvg',
            versionUrn,
            containerId,
            hasSvg: !!svg
        });
        return { ok: false, skipped: true, reason: 'missing versionUrn/containerId/accMarkupSvg' };
    }

    if (MARKUPS_UNAVAILABLE_CACHE.has(markupCacheKey)) {
        console.warn('⚠️ postContainerMarkup skipped (cached unavailable endpoint):', {
            projectId: normalizeProjectId(projectId),
            containerId
        });
        return {
            ok: false,
            skipped: true,
            reason: 'markups endpoint unavailable for this container',
            code: 'MARKUPS_ENDPOINT_NOT_AVAILABLE'
        };
    }

    const endpointCandidates = [
        // Primary endpoint from project relationships.markups.meta.link
        `https://developer.api.autodesk.com/issues/v1/containers/${encodeURIComponent(containerId)}/markups`,
        // Legacy/alternate endpoint kept as fallback.
        `https://developer.api.autodesk.com/construction/markups/v1/projects/${projectId}/containers/${encodeURIComponent(containerId)}/markups`
    ];

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
        },
        // Some tenants expect `urn` instead of `versionUrn`.
        {
            urn: versionUrn,
            issueId,
            svg,
            position: stamp.accPosition || stamp.accNormalizedPosition || { x: 0, y: 0, z: 0 },
            normalizedPosition: stamp.accNormalizedPosition || null,
            scale: Number(stamp.scale) || 1,
            viewId: stamp.viewId || null
        }
    ];

    let lastError = null;
    for (const endpoint of endpointCandidates) {
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
            lastError = { endpoint, status: response.status, statusText: response.statusText, body: parsedError, sentBody: body };
            console.warn('⚠️ postContainerMarkup attempt failed:', {
                endpoint,
                status: response.status,
                statusText: response.statusText,
                body: parsedError
            });

            if (response.status === 401 || response.status === 403) {
                return { ok: false, error: lastError };
            }
        }
    }

    if (lastError && Number(lastError.status) === 404) {
        MARKUPS_UNAVAILABLE_CACHE.add(markupCacheKey);
    }

    return { ok: false, error: lastError };
}

let app = express();
app.use(express.static('wwwroot'));
app.use(session({ secret: SERVER_SESSION_SECRET, maxAge: 24 * 60 * 60 * 1000 }));
app.use(express.json()); 

app.use(require('./routes/auth.js'));
app.use(require('./routes/hubs.js'));

app.post('/api/stamps/save', async (req, res) => {
    try {
        const key = String(req.body && req.body.key ? req.body.key : '').trim();
        const stamps = req.body && (req.body.stamps || req.body.payload);
        if (!key) return res.status(400).json({ success: false, message: 'key fehlt.' });
        if (!Array.isArray(stamps)) return res.status(400).json({ success: false, message: 'stamps muss ein Array sein.' });

        const fileName = storageKeyToFileName(key);
        if (!fileName) return res.status(400).json({ success: false, message: 'ungueltiger key.' });

        await ensureStampsDataDir();
        const filePath = path.join(STAMPS_DATA_DIR, fileName);
        const payload = {
            key,
            updatedAt: new Date().toISOString(),
            stamps
        };
        await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');

        res.json({ success: true, key, count: stamps.length });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/stamps/load', async (req, res) => {
    try {
        const key = String(req.query && req.query.key ? req.query.key : '').trim();
        if (!key) return res.status(400).json({ success: false, message: 'key fehlt.' });

        const fileName = storageKeyToFileName(key);
        if (!fileName) return res.status(400).json({ success: false, message: 'ungueltiger key.' });

        await ensureStampsDataDir();
        const filePath = path.join(STAMPS_DATA_DIR, fileName);

        if (!fs.existsSync(filePath)) {
            return res.json({ success: true, key, stamps: [] });
        }

        const raw = await fs.promises.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        const stamps = Array.isArray(parsed && parsed.stamps) ? parsed.stamps : [];
        res.json({ success: true, key, stamps });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/debug/build', (req, res) => {
    res.json({
        build: SERVER_BUILD,
        port: PORT,
        flags: {
            USE_2D_VECTOR_PIN,
            CLAMP_POS_DECIMALS,
            ENABLE_CONTAINER_MARKUP_POST,
            ISSUE_2D_LINKED_DOC_TYPE,
            RUNTIME_PREFERRED_2D_LINKED_DOC_TYPE
        }
    });
});
app.get('/api/debug/types', async (req, res) => {
    const token = req.session.internal_token;
    const projectId = normalizeProjectId(req.query.projectId);

    if (!projectId) {
        return res.status(400).send('Strict Mode: projectId query parameter fehlt.');
    }

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
        const projectId = normalizeProjectId(reqProjectIdRaw);
        if (!projectId) {
            throw new Error('Strict Mode: projectId query parameter fehlt.');
        }

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
        const targetProjectId = reqProjectId || stampProjectId;
        const targetProjectIdForProjectApi = normalizeProjectIdWithPrefix(reqProjectIdRaw || stampProjectIdRaw || targetProjectId);

        if (!targetHubId || !targetProjectIdForProjectApi) {
            return res.status(400).json({
                success: false,
                message: 'Strict Mode: hubId/projectId fehlen fuer den ACC Project-Lookup. Bitte im Sidebar-Baum Projektkontext auswaehlen.'
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
        if (!typeCatalog.ok) {
            throw new Error(`Strict Mode: aktive Subtypes konnten nicht geladen werden (${typeCatalog.error}).`);
        }

        const activeSubtypeIds = typeCatalog.activeSubtypeIds;
        const defaultActiveSubtypeId = typeCatalog.firstActiveSubtypeId || '';
        if (!defaultActiveSubtypeId || activeSubtypeIds.size === 0) {
            throw new Error('Strict Mode: kein aktiver Issue-Subtype im Projekt verfuegbar.');
        }
        
        const createdIssues = [];

        for (const stamp of stampsData) {
            const itemIdRaw = String(stamp.itemId || '').trim();
            const versionIdRaw = String(stamp.versionId || '').trim();
            const linkedDocumentUrn = String(stamp.linkedDocumentUrn || '').trim();
            const subtypeCandidate = String(stamp.issueSubtypeId || '').trim();

            if (!itemIdRaw || !versionIdRaw || !linkedDocumentUrn) {
                throw new Error(`Strict Mode: Stamp ${stamp.id || ''} hat kein itemId/versionId/linkedDocumentUrn.`);
            }

            if (!isLineageUrn(linkedDocumentUrn)) {
                throw new Error(`Strict Mode: Stamp ${stamp.id || ''} linkedDocumentUrn ist kein gueltiges dm.lineage URN.`);
            }

            if (!subtypeCandidate || !activeSubtypeIds.has(subtypeCandidate)) {
                throw new Error(`Strict Mode: Stamp ${stamp.id || ''} hat keinen aktiven issueSubtypeId.`);
            }

            console.log('📋 Processing stamp:', {
                id: stamp.id,
                stampKey: stamp.stampKey,
                linkedType: stamp.linkedDocumentType,
                is3D: stamp.is3D,
                viewId: stamp.viewId,
                itemId: itemIdRaw,
                versionId: versionIdRaw,
                linkedDocumentUrn
            });

            const requestedType = stamp.linkedDocumentType || (stamp.is3D ? 'ThreeDVectorPushpin' : ISSUE_2D_LINKED_DOC_TYPE);
            const is3D = requestedType === 'ThreeDVectorPushpin' || !!stamp.is3D;
            const is2D = !is3D;

            const pushpinPos = is2D
                ? (stamp.accNormalizedPosition || stamp.accPosition || stamp.dbWorld || stamp.worldPosition || stamp.position || { x: 0, y: 0, z: 0 })
                : (stamp.accPosition || stamp.dbWorld || stamp.worldPosition || stamp.position || { x: 0, y: 0, z: 0 });
            const viewName = (stamp.viewName && String(stamp.viewName).trim()) ? String(stamp.viewName) : 'ELIN Plan Prüfung';
            const createdAtVersion = (() => {
                const explicit = Number(stamp.createdAtVersion);
                if (Number.isInteger(explicit) && explicit > 0 && explicit < 1000) return explicit;
                const match = String(versionIdRaw || '').match(/[?&]version=(\d+)/i);
                if (match) {
                    const v = parseInt(match[1], 10);
                    if (Number.isInteger(v) && v > 0 && v < 1000) return v;
                }
                return 1;
            })();

            if (is2D && !stamp.viewId) {
                throw new Error(`Strict Mode: viewId fehlt fuer 2D-Stamp ${stamp.id || ''}.`);
            }

            // Keep precision from viewer coordinates.
            const positionPrecise = sanitizePosition(pushpinPos);

            const basePayload = {
                title: (stamp.title || 'ELIN Stempel').replace('Ã¼', 'ü'),
                // Keep newly created issues visible in ACC lists.
                status: 'open',
                issueSubtypeId: subtypeCandidate || defaultActiveSubtypeId,
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

            const sendIssue = async (payload) => sendIssueProject(payload);

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

            const active2DType = RUNTIME_PREFERRED_2D_LINKED_DOC_TYPE || ISSUE_2D_LINKED_DOC_TYPE;

            const payload2D = {
                ...basePayload,
                linkedDocuments: [
                    {
                        type: active2DType,
                        urn: linkedDocumentUrn,
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

            const ALT_2D_LINKED_DOC_TYPE = getAlt2DLinkedDocType(active2DType);

            const payload2DAlternateType = {
                ...basePayload,
                linkedDocuments: [
                    {
                        type: ALT_2D_LINKED_DOC_TYPE,
                        urn: linkedDocumentUrn,
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

            const payload3DPrimary = {
                ...basePayload,
                linkedDocuments: [
                    {
                        type: 'ThreeDVectorPushpin',
                        urn: linkedDocumentUrn,
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
                        urn: linkedDocumentUrn,
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
                result = await sendIssue(payload2D);

                if (!result.response.ok) {
                    console.error('❌ 2D Pushpin Versuch fehlgeschlagen:', {
                        urnCandidate: linkedDocumentUrn,
                        status: result.response.status,
                        statusText: result.response.statusText,
                        autodeskError: result.parsedError || result.responseText,
                        requestPayload: payload2D,
                        issuesContainerId
                    });

                    const e2d = result.parsedError || {};
                    const markupFailed = e2d.errorCode === 'ISSUES_SERVICE_FAILED_TO_UPDATE_MARKUPS';
                    const canRetryType = Number(result.response.status) === 400 || markupFailed;
                    if (canRetryType) {
                        console.warn(`⚠️ 2D Retry mit alternativem linkedDocuments.type=${ALT_2D_LINKED_DOC_TYPE}`);
                        result = await sendIssue(payload2DAlternateType);
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

                if (is2D && result.requestPayload && Array.isArray(result.requestPayload.linkedDocuments)) {
                    const usedType = result.requestPayload.linkedDocuments[0] && result.requestPayload.linkedDocuments[0].type;
                    if (usedType && usedType !== RUNTIME_PREFERRED_2D_LINKED_DOC_TYPE) {
                        RUNTIME_PREFERRED_2D_LINKED_DOC_TYPE = usedType;
                        console.log('✅ Runtime 2D type learned:', { RUNTIME_PREFERRED_2D_LINKED_DOC_TYPE });
                    }
                }

                if (ENABLE_CONTAINER_MARKUP_POST) {
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
                        if (markupResult.error && markupResult.error.status === 404) {
                            accIssue.markupWarningCode = 'MARKUPS_ENDPOINT_NOT_AVAILABLE';
                            accIssue.markupWarningHint = 'In diesem ACC-Tenant ist der Markups-Endpoint fuer Container nicht verfuegbar (404). Der Issue-Pushpin bleibt, aber das benutzerdefinierte SVG-Stamping wird nicht angezeigt.';
                        }
                        console.warn('⚠️ Markup POST fehlgeschlagen:', JSON.stringify(markupResult.error));
                    }
                } else {
                    accIssue.markupSkipped = true;
                    accIssue.markupSkipReason = 'ENABLE_CONTAINER_MARKUP_POST=false';
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

            if (
                errorCode === 'ISSUES_SERVICE_FAILED_TO_UPDATE_MARKUPS'
                && result.parsedError
                && result.parsedError.metadata
                && result.parsedError.metadata.issueId
            ) {
                const issueId = String(result.parsedError.metadata.issueId).trim();
                console.warn('⚠️ ACC hat ein Issue erzeugt, aber Pushpin/Annotation konnte nicht gespeichert werden. Lade Issue per issueId nach.', {
                    issueId,
                    targetProjectId,
                    is2D,
                    is3D
                });

                const lookup = await getIssueByIdWithRetry({
                    token,
                    projectId: targetProjectId,
                    issueId,
                    retries: 6,
                    delayMs: 600
                });
                if (lookup.exists) {
                    const verifiedIssue = lookup.issue || { id: issueId, displayId: issueId };
                    createdIssues.push({
                        ...verifiedIssue,
                        warning: is2D
                            ? 'Issue erstellt, aber ACC konnte den 2D-Pushpin/Annotation nicht speichern.'
                            : 'Issue erstellt, aber ACC konnte den 3D-Pushpin/Annotation nicht speichern.'
                    });
                    continue;
                }

                // Some tenants are eventually consistent and return 404 for fresh issueId for a short period.
                console.warn('⚠️ Issue-Lookup nach mehreren Retries nicht verfuegbar, liefere synthetic success mit warning.', {
                    issueId,
                    attempts: lookup.attempts || 1,
                    lookupStatus: lookup.status || null,
                    lookupStatusText: lookup.statusText || null,
                    lookupRaw: lookup.raw || null
                });

                createdIssues.push({
                    id: issueId,
                    displayId: issueId,
                    warning: is2D
                        ? 'Issue wurde von ACC gemeldet, ist aber noch nicht abrufbar; 2D-Pushpin/Annotation konnte nicht gespeichert werden.'
                        : 'Issue wurde von ACC gemeldet, ist aber noch nicht abrufbar; 3D-Pushpin/Annotation konnte nicht gespeichert werden.',
                    lookup: {
                        attempts: lookup.attempts || 1,
                        status: lookup.status || null,
                        statusText: lookup.statusText || null
                    }
                });
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
            const stampProjectId = normalizeProjectId(stamp.projectId || req.body.projectId);
            if (!stampProjectId) {
                throw new Error(`Strict Mode: projectId fehlt fuer Stamp ${stamp.id || ''} in /api/markups/create.`);
            }

            const versionUrn = resolveVersionUrn(stamp);
            if (!versionUrn) {
                throw new Error(`Stamp ${stamp.id || ''}: versionUrn konnte nicht bestimmt werden.`);
            }

            const svgString = buildPlacedStampSvg(stamp);
            const title = stamp.title || `ELIN: ${stamp.stampKey || 'Stempel'}`;

            const result = await postMarkupToAcc({ token, versionUrn, svgString, title, projectId: stampProjectId });
            if (!result.ok) {
                if (result.error && result.error.status === 404) {
                    const fallbackResult = await createIssuePushpinFallback({ token, stamp, projectId: stampProjectId });
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