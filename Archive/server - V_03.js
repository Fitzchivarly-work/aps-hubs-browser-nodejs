const express = require('express');
const session = require('cookie-session');
const { PORT, SERVER_SESSION_SECRET } = require('../config.js');

let app = express();
app.use(express.static('wwwroot'));
app.use(session({ secret: SERVER_SESSION_SECRET, maxAge: 24 * 60 * 60 * 1000 }));
app.use(express.json()); 

app.use(require('../routes/auth.js'));
app.use(require('../routes/hubs.js'));
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
            let decodedUrn = stamp.urn;
            if (!stamp.urn.startsWith('urn:adsk')) {
                const buffer = Buffer.from(stamp.urn, 'base64');
                decodedUrn = buffer.toString('utf-8').split('?')[0]; 
            }

            // ACC verlangt oft das dm.lineage Format
            const lineageUrn = decodedUrn.replace(':fs.file:vf.', ':dm.lineage:').replace(':fs.file:v.', ':dm.lineage:');

            const issuePayload = {
                title: stamp.title.replace('Ã¼', 'ü'),
                status: stamp.status,
                // Hier werden jetzt die korrekten Unterkategorien zugewiesen
                issueSubtypeId: stamp.type === 'mangel' ? SUBTYPE_ID_MANGEL : SUBTYPE_ID_ALLGEMEIN,
                linkedDocuments: [
                    {
                        type: "TwoDVectorPushpin", 
                        urn: lineageUrn,
                        createdAtVersion: stamp.version || 1, // Muss ein Integer sein
                        details: {
                            viewable: {
                                id: stamp.viewId,
                                name: "ELIN Plan Prüfung",
                                is3D: false
                            },
                            position: { x: stamp.position.x, y: stamp.position.y, z: stamp.position.z }
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

            const responseText = await response.text();
            if (!response.ok) {
                console.error("Autodesk API Fehler Details:", responseText);
                throw new Error(`ACC lehnte das Issue ab: ${response.statusText}`);
            }

            const accIssue = JSON.parse(responseText);
            createdIssues.push(accIssue);
            console.log(`✅ Aufgabe in ACC erstellt: ${accIssue.displayId}`);
        }

        res.status(200).json({ success: true, message: `${createdIssues.length} Aufgaben erfolgreich erstellt!` });

    } catch (err) {
        console.error("Fehler beim Erstellen der ACC Issues:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}...`));