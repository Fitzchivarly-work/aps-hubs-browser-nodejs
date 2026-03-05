const fs = require('fs');
const DxfParser = require('dxf-parser');

// AutoCAD Standard-Farben (ACI) zu HEX
const ACI_COLORS = {
    1: '#FF0000', 2: '#FFFF00', 3: '#00FF00', 4: '#00FFFF',
    5: '#0000FF', 6: '#FF00FF', 7: '#000000', 8: '#808080', 9: '#C0C0C0'
};

function getHexColor(colorIndex) {
    if (!colorIndex) return '#005aa9'; // ELIN Standard-Blau als Fallback
    return ACI_COLORS[colorIndex] || `#${colorIndex.toString(16).padStart(6, '0')}`;
}

// Hilfsfunktion: Polarkoordinaten für SVG (inkl. Y-Achsen-Spiegelung für SVG)
function polarToCartesian(cx, cy, r, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    // Y wird negativ gesetzt, da SVG die Y-Achse nach unten zählt (AutoCAD nach oben)
    return { 
        x: cx + r * Math.cos(rad), 
        y: -cy - r * Math.sin(rad) 
    };
}

const parser = new DxfParser();

try {
    console.log("Lese DXF Datei...");
    const fileContent = fs.readFileSync('./ELIN-SYMBOLE_Drawboard_Markup.dxf', 'utf-8');
    const dxf = parser.parseSync(fileContent);
    const stampLibrary = {};

    let processedCount = 0;

    for (const blockName in dxf.blocks) {
        if (blockName.startsWith('*')) continue; // Interne Blöcke ignorieren

        const block = dxf.blocks[blockName];
        let paths = [];
        
        // Bounding Box Variablen zur automatischen Zentrierung
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        function updateBounds(x, y) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }

        block.entities.forEach(e => {
            const color = getHexColor(e.colorNumber);
            // Linienstärke: Fallback auf 1.5, wenn nichts definiert ist
            const strokeWidth = (e.lineThickness || e.lineTypeScale || 1.5) * 0.8; 

            if (e.type === 'LINE') {
                const x1 = e.vertices[0].x, y1 = -e.vertices[0].y;
                const x2 = e.vertices[1].x, y2 = -e.vertices[1].y;
                updateBounds(x1, y1); updateBounds(x2, y2);
                
                paths.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" />`);
            } 
            else if (e.type === 'CIRCLE') {
                const cx = e.center.x, cy = -e.center.y, r = e.radius;
                updateBounds(cx - r, cy - r); updateBounds(cx + r, cy + r);
                
                paths.push(`<circle cx="${cx}" cy="${cy}" r="${r}" stroke="${color}" stroke-width="${strokeWidth}" fill="none" />`);
            } 
            else if (e.type === 'ARC') {
                const start = polarToCartesian(e.center.x, e.center.y, e.radius, e.startAngle);
                const end = polarToCartesian(e.center.x, e.center.y, e.radius, e.endAngle);
                
                updateBounds(start.x, start.y); updateBounds(end.x, end.y);
                updateBounds(e.center.x, -e.center.y); // Grobe Näherung für Bounding Box

                let diff = e.endAngle - e.startAngle;
                if (diff < 0) diff += 360;
                const largeArc = diff > 180 ? 1 : 0;
                
                paths.push(`<path d="M ${start.x} ${start.y} A ${e.radius} ${e.radius} 0 ${largeArc} 0 ${end.x} ${end.y}" stroke="${color}" stroke-width="${strokeWidth}" fill="none" stroke-linecap="round" />`);
            }
            else if (e.type === 'ELLIPSE') {
                const cx = e.center.x, cy = -e.center.y;
                // Berechnung der Radien basierend auf DXF Daten
                const rx = Math.hypot(e.majorAxisEndPoint.x, e.majorAxisEndPoint.y);
                const ry = rx * e.axisRatio;
                // Rotationswinkel der Ellipse
                const rotDeg = Math.atan2(-e.majorAxisEndPoint.y, e.majorAxisEndPoint.x) * (180 / Math.PI);
                
                updateBounds(cx - rx, cy - rx); updateBounds(cx + rx, cy + rx);

                paths.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(${rotDeg}, ${cx}, ${cy})" stroke="${color}" stroke-width="${strokeWidth}" fill="none" />`);
            }
            else if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') {
                if (!e.vertices || e.vertices.length === 0) return;
                
                let pts = e.vertices.map(v => {
                    const x = v.x, y = -v.y;
                    updateBounds(x, y);
                    return `${x},${y}`;
                }).join(' ');

                // Schließt die Polylinie, falls sie als geschlossen markiert ist
                if (e.shape || e.closed) {
                    pts += ` ${e.vertices[0].x},${-e.vertices[0].y}`;
                }

                paths.push(`<polyline points="${pts}" stroke="${color}" stroke-width="${strokeWidth}" fill="none" stroke-linejoin="round" stroke-linecap="round" />`);
            }
        });

        if (paths.length > 0 && minX !== Infinity) {
            // Ein bisschen Padding (Abstand zum Rand) hinzufügen, damit dicke Linien nicht abgeschnitten werden
            const pad = 2;
            const width = (maxX - minX) + (pad * 2);
            const height = (maxY - minY) + (pad * 2);
            const viewBox = `${minX - pad} ${minY - pad} ${width} ${height}`;

            stampLibrary[blockName] = {
                label: blockName.substring(0, 2),
                // WICHTIG: Wir übergeben die dynamische viewBox in das SVG-Attribut
                viewBox: viewBox,
                svg: paths.join('\n')
            };
            processedCount++;
        }
    }

    fs.writeFileSync('./wwwroot/stamps.json', JSON.stringify(stampLibrary, null, 2));
    console.log(`✅ Erfolgreich! ${processedCount} Symbole inkl. Farben, Bögen, Ellipsen und Polylinien exportiert.`);

} catch (err) { 
    console.error("❌ Fehler beim Konvertieren:", err); 
}