const fs = require('fs');
const DxfParser = require('dxf-parser');

// AutoCAD Standard-Farben (ACI) Mapping
const ACI_COLORS = {
    1: '#FF0000', 2: '#FFFF00', 3: '#00FF00', 4: '#00FFFF',
    5: '#0000FF', 6: '#FF00FF', 7: '#000000', 8: '#808080', 9: '#C0C0C0'
};

function getHexColor(e) {
    if (e.colorNumber === 256 || e.colorNumber === 0 || !e.colorNumber) return '#005aa9'; // ELIN Blau
    return ACI_COLORS[e.colorNumber] || '#000000';
}

const parser = new DxfParser();

try {
    console.log("Lese DXF Datei für ACC-Markup Konvertierung...");
    const fileContent = fs.readFileSync('./ELIN-SYMBOLE_Drawboard_Markup.dxf', 'utf-8');
    const dxf = parser.parseSync(fileContent);
    const stampLibrary = {};

    for (const blockName in dxf.blocks) {
        if (blockName.startsWith('*')) continue;

        const block = dxf.blocks[blockName];
        let paths = [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        function updateBounds(x, y) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }

        block.entities.forEach(e => {
            const color = getHexColor(e);
            const strokeWidth = 2; // Optimale Dicke für ACC Pläne

            if (e.type === 'LINE') {
                const x1 = e.vertices[0].x, y1 = -e.vertices[0].y;
                const x2 = e.vertices[1].x, y2 = -e.vertices[1].y;
                updateBounds(x1, y1); updateBounds(x2, y2);
                paths.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${strokeWidth}" />`);
            } 
            else if (e.type === 'CIRCLE') {
                const cx = e.center.x, cy = -e.center.y, r = e.radius;
                updateBounds(cx - r, cy - r); updateBounds(cx + r, cy + r);
                paths.push(`<circle cx="${cx}" cy="${cy}" r="${r}" stroke="${color}" stroke-width="${strokeWidth}" fill="none" />`);
            } 
            else if (e.type === 'ARC') {
                const startRad = (e.startAngle * Math.PI) / 180;
                const endRad = (e.endAngle * Math.PI) / 180;
                const x1 = e.center.x + e.radius * Math.cos(startRad);
                const y1 = -(e.center.y + e.radius * Math.sin(startRad));
                const x2 = e.center.x + e.radius * Math.cos(endRad);
                const y2 = -(e.center.y + e.radius * Math.sin(endRad));
                updateBounds(x1, y1); updateBounds(x2, y2);

                let sweep = e.endAngle - e.startAngle;
                if (sweep < 0) sweep += 360;
                const largeArc = sweep > 180 ? 1 : 0;
                paths.push(`<path d="M ${x1} ${y1} A ${e.radius} ${e.radius} 0 ${largeArc} 0 ${x2} ${y2}" stroke="${color}" stroke-width="${strokeWidth}" fill="none" />`);
            }
            else if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') {
                const pts = e.vertices.map(v => {
                    updateBounds(v.x, -v.y);
                    return `${v.x},${-v.y}`;
                }).join(' ');
                paths.push(`<polyline points="${pts}" stroke="${color}" stroke-width="${strokeWidth}" fill="none" />`);
            }
        });

        if (paths.length > 0) {
            const width = maxX - minX;
            const height = maxY - minY;
            const viewBox = `${minX} ${minY} ${width} ${height}`;

            // Das ACC-Format erfordert oft ein umschließendes SVG-Tag mit Namespace
            const accSvgWrapper = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${paths.join('')}</svg>`;

            stampLibrary[blockName] = {
                label: blockName,
                viewBox: viewBox,
                width: width,
                height: height,
                accMarkupSvg: accSvgWrapper // Diesen String senden wir an die API
            };
        }
    }

    fs.writeFileSync('./wwwroot/stamps.json', JSON.stringify(stampLibrary, null, 2));
    console.log("✅ ACC-Markup Konvertierung abgeschlossen.");
} catch (err) { console.error(err); }