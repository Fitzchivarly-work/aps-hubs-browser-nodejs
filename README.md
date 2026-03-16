# ELIN Viewer

ELIN Viewer ist eine Node.js-basierte Webanwendung für Autodesk Platform Services (APS) und Autodesk Construction Cloud (ACC). Die Anwendung kombiniert einen Modell- und Dokument-Viewer mit einer projektspezifischen Stempel-Erweiterung, über die Prüf- und Markierungssymbole in 2D- und 3D-Modellen platziert, gespeichert und als ACC Issues weiterverarbeitet werden können.

Die Basis des Projekts stammt aus dem APS Hubs Browser, wurde aber funktional deutlich erweitert: Neben der Navigation durch Hubs, Projekte, Ordner und Versionen enthält das Projekt eine ELIN-spezifische Stempelbibliothek, serverseitige Persistenz und ACC-Issue-/Markup-Workflows.

## Funktionsumfang

- Anmeldung über Autodesk OAuth (3-legged)
- Navigation durch Hubs, Projekte, Ordner, Dateien und Versionen in ACC/BIM 360
- Laden von 2D- und 3D-Modellen im Autodesk Viewer
- ELIN Stamp Extension mit Stempelbibliothek aus `wwwroot/stamps.json`
- Platzieren, Auswählen, Verschieben, Skalieren und Löschen von Stempeln
- Mehrfachauswahl mit Bearbeitung gemeinsamer Eigenschaften
- Serverseitige Persistenz der platzierten Stempel unter `data/stamps/`
- Umwandlung ausgewählter Stempel in ACC Issues inklusive Pushpin-Verknüpfung
- Optionales Schreiben zusätzlicher Container-Markups für unterstützte ACC-Tenants
- Debug-Endpunkte für Build- und ACC-Issue-Kontext

## Architektur im Überblick

### Frontend

- `wwwroot/index.html`: Einstiegspunkt der Anwendung
- `wwwroot/main.js`: Login-Status, Responsive-Sidebar und Initialisierung
- `wwwroot/sidebar.js`: Baumansicht für Hubs, Projekte, Ordner, Items und Versionen
- `wwwroot/viewer.js`: Initialisierung des Autodesk Viewers
- `wwwroot/ElinStampExtension.js`: ELIN-spezifische Stempel- und ACC-Issue-Logik im Viewer
- `wwwroot/stamps.json`: Stempeldefinitionen im SVG-/ACC-Markup-Format

### Backend

- `server.js`: Express-Server, Persistenz, ACC-Issue-Integration, Markup-Logik und Debug-Routen
- `routes/auth.js`: Autodesk OAuth Login, Callback, Logout und Token-Refresh
- `routes/hubs.js`: APIs für Hub-, Projekt-, Inhalts- und Versionsnavigation
- `services/aps.js`: APS Authentifizierung und Data-Management-Zugriffe
- `config.js`: Umgebungsvariablen und OAuth-Scopes

### Datenhaltung

- `data/stamps/`: gespeicherte Stempelstände pro Modell-/Dokumentkontext
- `Stempeln/` und `ELIN-SYMBOLE_Drawboard_Markup.dxf`: Quelle für Stempeldefinitionen
- `convert.js`: Konvertierung von DXF-Blöcken nach `wwwroot/stamps.json`

## Voraussetzungen

- Node.js 18 oder neuer
- npm
- APS App mit Client ID und Client Secret
- Berechtigung auf die gewünschten ACC-/BIM-360-Projekte

Hinweis: Das Projekt verwendet serverseitig das globale `fetch`. Deshalb sollte keine alte Node.js-Version verwendet werden.

## Installation

Repository öffnen und Abhängigkeiten installieren:

```bash
npm install
```

Anschließend eine `.env`-Datei im Projektverzeichnis anlegen:

```bash
APS_CLIENT_ID="<client-id>"
APS_CLIENT_SECRET="<client-secret>"
APS_CALLBACK_URL="http://localhost:3000/api/auth/callback"
SERVER_SESSION_SECRET="<beliebiges-geheimes-passwort>"
PORT=3000

# Optionale ACC-Flags
USE_2D_VECTOR_PIN=false
CLAMP_POS_DECIMALS=-1
ENABLE_CONTAINER_MARKUP_POST=true
```

### Bedeutung der Variablen

- `APS_CLIENT_ID`: Client ID der APS-App
- `APS_CLIENT_SECRET`: Client Secret der APS-App
- `APS_CALLBACK_URL`: OAuth-Callback-URL; muss auch in der APS-App hinterlegt sein
- `SERVER_SESSION_SECRET`: Secret für die Session-Cookies
- `PORT`: HTTP-Port des lokalen Servers, Standard ist `3000`

### Optionale ACC-Flags

- `USE_2D_VECTOR_PIN`: verwendet für 2D `TwoDVectorPushpin` statt `TwoDRasterPushpin`
- `CLAMP_POS_DECIMALS`: rundet Koordinaten, `-1` bedeutet volle Präzision
- `ENABLE_CONTAINER_MARKUP_POST`: aktiviert/deaktiviert den zusätzlichen Markup-POST für Container-Endpunkte

## Anwendung starten

```bash
npm start
```

Danach die Anwendung im Browser öffnen:

```text
http://localhost:3000
```

## Typischer Workflow

1. Über `Login` mit dem Autodesk-Konto anmelden.
2. In der linken Baumansicht Hub, Projekt, Ordner, Datei und gewünschte Version auswählen.
3. Das Modell oder Dokument wird im Viewer geladen.
4. In der ELIN Stamp Extension einen Stempel aus der Bibliothek auswählen.
5. Stempel im Modell platzieren und bei Bedarf Farbe, Text, Typ oder Größe anpassen.
6. Stempel werden serverseitig gespeichert und beim erneuten Laden des gleichen Kontexts wiederhergestellt.
7. Ausgewählte Stempel können als ACC Issues an den Server gesendet werden.

Wichtig: Für das Erstellen von ACC Issues muss ein gültiger Projektkontext aus der Sidebar vorhanden sein. Die Anwendung verwendet `hubId`, `projectId`, `itemId` und `versionId` aus der aktuellen Auswahl.

## Relevante API-Endpunkte

### Authentifizierung und Navigation

- `GET /api/auth/login`: Autodesk Login starten
- `GET /api/auth/logout`: Session beenden
- `GET /api/auth/token`: Public Viewer Token abrufen
- `GET /api/auth/profile`: Benutzerprofil abrufen
- `GET /api/hubs`: verfügbare Hubs laden
- `GET /api/hubs/:hub_id/projects`: Projekte eines Hubs laden
- `GET /api/hubs/:hub_id/projects/:project_id/contents`: Projektinhalt oder Ordnerinhalt laden
- `GET /api/hubs/:hub_id/projects/:project_id/contents/:item_id/versions`: Versionen einer Datei laden

### Stempel und Issues

- `POST /api/stamps/save`: Stempelzustand für einen Kontext speichern
- `GET /api/stamps/load`: gespeicherte Stempel laden
- `GET /api/issues/types`: aktive ACC-Issue-Subtypes über Projekt-ID laden
- `GET /api/hubs/:hubId/projects/:projectId/issuetypes`: aktive ACC-Issue-Subtypes im Hub-/Projektkontext laden
- `POST /api/issues/create`: ausgewählte Stempel in ACC Issues umwandeln
- `POST /api/markups/create`: ACC-Markups direkt erzeugen oder auf Issue-Pushpins zurückfallen

### Debug

- `GET /api/debug/build`: Build-Stand und aktive Runtime-Flags anzeigen
- `GET /api/debug/types?projectId=...`: ACC-Issue-Typen inklusive Subtypes im HTML-Format anzeigen

## Stempelbibliothek pflegen

Die im Viewer angezeigten Symbole werden aus `wwwroot/stamps.json` geladen. Diese Datei kann aus der DXF-Datei `ELIN-SYMBOLE_Drawboard_Markup.dxf` neu erzeugt werden.

Konvertierung ausführen:

```bash
node convert.js
```

Die Konvertierung:

- liest DXF-Blöcke ein
- wandelt Linien, Kreise, Bögen und Polylinien in SVG um
- erzeugt zusätzlich `accMarkupSvg` für den ACC-Markup-Workflow
- schreibt das Ergebnis nach `wwwroot/stamps.json`

## Besondere ACC-Hinweise

- Das Projekt ist auf europäische Viewer-Nutzung ausgelegt und initialisiert den Viewer mit `derivativeV2_EU`.
- Nicht jeder ACC-Tenant unterstützt dieselben Markup-Endpunkte. In manchen Umgebungen kann die Issue-Erstellung funktionieren, während das zusätzliche SVG-Markup nicht gespeichert werden kann.
- Für 2D-Verknüpfungen wird ein gültiges `dm.lineage`-URN-Format benötigt.
- Die Anwendung lädt aktive Issue-Subtypes dynamisch aus ACC und verwendet bei Bedarf einen aktiven Fallback-Subtype.
- Runtime-Informationen zu Flags und bevorzugtem 2D-Linked-Document-Typ sind über `/api/debug/build` sichtbar.

## Projektstruktur

```text
.
|-- config.js
|-- convert.js
|-- server.js
|-- routes/
|   |-- auth.js
|   `-- hubs.js
|-- services/
|   `-- aps.js
|-- data/
|   `-- stamps/
|-- Stempeln/
|-- wwwroot/
|   |-- ElinStampExtension.js
|   |-- index.html
|   |-- main.css
|   |-- main.js
|   |-- sidebar.js
|   |-- stamps.json
|   `-- viewer.js
`-- README.md
```

## Bekannte Grenzen

- Die Qualität und Sichtbarkeit von 2D-Pushpins hängt vom jeweiligen ACC-Tenant und dessen Markup-Unterstützung ab.
- Wenn für ein Projekt keine aktiven Issue-Subtypes verfügbar sind, können keine ACC Issues erstellt werden.
- Die Stempelablage ist dateibasiert und lokal an dieses Deployment gebunden.

## Lizenz

Dieses Projekt steht unter der MIT-Lizenz. Details siehe `LICENSE`.
