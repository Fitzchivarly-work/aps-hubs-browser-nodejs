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
    const projectId = "bd116dfe-b5d8-4cf9-98ed-68bb5316db04";

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
        const stampsData = req.body.stamps;
        const token = req.session.internal_token; 
        if (!token) throw new Error("Kein Benutzer-Token gefunden. Bitte neu einloggen.");

        const PROJECT_ID = "bd116dfe-b5d8-4cf9-98ed-68bb5316db04"; 
        
        // --- DIE ECHTEN ROTEN IDs AUS DEINEM PROJEKT ---
        // Kategorie: Allgemein -> Unterkategorie: Mangel
        const SUBTYPE_ID_MANGEL = "3f0a4ddd-8377-465c-835c-ad72b8aa2439"; 
        // Kategorie: Allgemein -> Unterkategorie: Allgemein
        const SUBTYPE_ID_ALLGEMEIN = "2c12ca9f-5317-5200-b91f-8c7094cd42e4";

        const createdIssues = [];

        for (const stamp of stampsData) {
            // URN Dekodieren: Von dXJu... (Base64) zu urn:adsk... (Klartext)
            let decodedUrnFull = stamp.urn;
            if (!stamp.urn.startsWith('urn:adsk')) {
                const buffer = Buffer.from(stamp.urn, 'base64');
                decodedUrnFull = buffer.toString('utf-8');
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
            const lineageUrnNoQuery = decodedUrnNoQuery.replace(':fs.file:vf.', ':dm.lineage:').replace(':fs.file:v.', ':dm.lineage:');
            const lineageUrnWithQuery = decodedUrnFull.replace(':fs.file:vf.', ':dm.lineage:').replace(':fs.file:v.', ':dm.lineage:');

            const requestedType = stamp.linkedDocumentType || "TwoDVectorPushpin";
            const is2D = requestedType === 'TwoDVectorPushpin';
            const pushpinPos = stamp.accPosition || stamp.position || { x: 0, y: 0, z: 0 };
            const viewName = (stamp.viewName && String(stamp.viewName).trim()) ? String(stamp.viewName) : 'ELIN Plan Prüfung';

            // Position muss Integer-Werte haben für ACC API
            const positionInt = {
                x: Math.round(Number(pushpinPos.x) || 0),
                y: Math.round(Number(pushpinPos.y) || 0),
                z: Math.round(Number(pushpinPos.z) || 0)
            };

            const basePayload = {
                title: (stamp.title || 'ELIN Stempel').replace('Ã¼', 'ü'),
                status: stamp.status,
                issueSubtypeId: stamp.type === 'mangel' ? SUBTYPE_ID_MANGEL : SUBTYPE_ID_ALLGEMEIN,
                description: [
                    stamp.stampKey ? `StampKey: ${stamp.stampKey}` : null,
                    stamp.stampLabel ? `StampLabel: ${stamp.stampLabel}` : null,
                    (typeof stamp.scale === 'number') ? `Scale: ${stamp.scale}` : null
                ].filter(Boolean).join(' | ') || undefined
            };

            const sendIssue = async (payload) => {
                console.log('📤 Sending to ACC API:', JSON.stringify(payload, null, 2));
                const response = await fetch(`https://developer.api.autodesk.com/construction/issues/v1/projects/${PROJECT_ID}/issues`, {
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
                        urn: lineageUrnNoQuery,
                        createdAtVersion: stamp.version || 1,
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

            const payload3DPrimary = {
                ...basePayload,
                linkedDocuments: [
                    {
                        type: 'ThreeDVectorPushpin',
                        urn: lineageUrnNoQuery,
                        createdAtVersion: stamp.version || 1,
                        details: {
                            viewable: {
                                id: stamp.viewId,
                                name: viewName,
                                is3D: true
                            },
                            position: positionInt
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
                        createdAtVersion: stamp.version || 1,
                        details: {
                            viewable: {
                                id: stamp.viewId,
                                name: viewName,
                                is3D: true
                            },
                            position: positionInt
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