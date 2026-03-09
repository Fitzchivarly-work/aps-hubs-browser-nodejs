const express = require('express');
const session = require('cookie-session');
const { PORT, SERVER_SESSION_SECRET } = require('./config.js');
const SERVER_BUILD = '2026-03-04-2d-markup-stable';

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
    const projectIdRaw = String(req.query.projectId || '').trim();
    const projectId = projectIdRaw.replace(/^b\./i, '');
    if (!projectId) {
        return res.status(400).send('projectId query parameter fehlt.');
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
app.post('/api/issues/create', async (req, res) => {
    try {
        console.log(`🚀 /api/issues/create build=${SERVER_BUILD}`);
        const stampsData = Array.isArray(req.body.stamps) ? req.body.stamps : [];
        const token = req.session.internal_token; 
        if (!token) throw new Error("Kein Benutzer-Token gefunden. Bitte neu einloggen.");
        if (stampsData.length === 0) throw new Error('Keine Stempel-Daten erhalten (stamps ist leer).');

        const reqProjectIdRaw = String(req.body.projectId || '').trim();
        const firstStampProjectIdRaw = String((stampsData[0] && stampsData[0].projectId) || '').trim();
        const targetProjectId = (reqProjectIdRaw || firstStampProjectIdRaw || '').replace(/^b\./i, '');
        if (!targetProjectId) {
            throw new Error('Fehlende projectId im Request. Bitte Blatt in der Sidebar neu auswählen.');
        }

        const createdIssues = [];

        for (const stamp of stampsData) {
            const linkedDocumentUrn = String(stamp.linkedDocumentUrn || '').trim();
            const versionId = String(stamp.versionId || '').trim();
            const createdAtVersion = Number.isFinite(Number(stamp.createdAtVersion)) && Number(stamp.createdAtVersion) > 0
                ? Math.round(Number(stamp.createdAtVersion))
                : (() => {
                    const m = versionId.match(/[?&]version=(\d+)/i);
                    if (m) {
                        const v = parseInt(m[1], 10);
                        if (Number.isFinite(v) && v > 0) return v;
                    }
                    return 1;
                })();

            if (!linkedDocumentUrn) {
                throw new Error(`Stamp ${stamp.id || ''}: linkedDocumentUrn fehlt im Request.`);
            }

            console.log('📋 Processing stamp:', {
                id: stamp.id,
                stampKey: stamp.stampKey,
                linkedType: stamp.linkedDocumentType,
                is3D: stamp.is3D,
                viewId: stamp.viewId,
                linkedDocumentUrn,
                versionId,
                createdAtVersion,
                projectId: targetProjectId
            });

            const requestedType = stamp.linkedDocumentType || "TwoDVectorPushpin";
            const is2D = requestedType === 'TwoDVectorPushpin';
            const pushpinPos = is2D
                ? (stamp.accNormalizedPosition || stamp.accPosition || stamp.position || { x: 0, y: 0, z: 0 })
                : (stamp.accPosition || stamp.position || { x: 0, y: 0, z: 0 });
            const viewName = (stamp.viewName && String(stamp.viewName).trim()) ? String(stamp.viewName) : 'ELIN Plan Prüfung';

            // Keep exact float precision for ACC pushpins (especially 2D).
            const positionPrecise = {
                x: Number(pushpinPos.x) || 0,
                y: Number(pushpinPos.y) || 0,
                z: Number(pushpinPos.z) || 0
            };

            const subtypeFromRequest = String(stamp.issueSubtypeId || '').trim();

            const basePayload = {
                title: (stamp.title || 'ELIN Stempel').replace('Ã¼', 'ü'),
                status: (stamp.status && String(stamp.status).trim()) ? String(stamp.status).trim() : 'open',
                ...(subtypeFromRequest ? { issueSubtypeId: subtypeFromRequest } : {}),
                description: [
                    stamp.stampKey ? `StampKey: ${stamp.stampKey}` : null,
                    stamp.stampLabel ? `StampLabel: ${stamp.stampLabel}` : null,
                    (typeof stamp.scale === 'number') ? `Scale: ${stamp.scale}` : null
                ].filter(Boolean).join(' | ') || undefined
            };

            const sendIssue = async (payload) => {
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
                let parsedError = null;
                if (!response.ok) {
                    try { parsedError = JSON.parse(responseText); } catch (e) { /* ignore */ }
                }
                return { response, responseText, parsedError };
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

            let result = await sendIssue(is2D ? payload2D : payload3DPrimary);

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
                const accIssue = JSON.parse(result.responseText);
                createdIssues.push(accIssue);
                console.log(`✅ Aufgabe in ACC erstellt: ${accIssue.displayId}`);
                continue;
            }

            const errorCode = result.parsedError && result.parsedError.errorCode ? result.parsedError.errorCode : null;
            const detail = detailToText(result.parsedError ? result.parsedError.details : '');

            if (result.response.status === 401 || errorCode === 'AUTH-006') {
                throw new Error('ACC Token ist abgelaufen oder ungültig (AUTH-006). Bitte neu einloggen und erneut senden.');
            }

            if (errorCode === 'ISSUES_SERVICE_FAILED_TO_UPDATE_MARKUPS' && result.parsedError && result.parsedError.metadata && result.parsedError.metadata.issueId) {
                createdIssues.push({
                    id: result.parsedError.metadata.issueId,
                    displayId: result.parsedError.metadata.issueId,
                    warning: 'Issue erstellt, aber Markup konnte nicht platziert werden.'
                });
                console.warn('⚠️ Issue erstellt, aber Markup fehlgeschlagen:', result.parsedError.metadata.issueId, detail);
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

app.listen(PORT, () => console.log(`Server listening on port ${PORT}...`));