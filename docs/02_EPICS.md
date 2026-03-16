# ELIN Viewer Epics

Diese Epics sind aus der Roadmap abgeleitet und in derselben Prioritaet geordnet.

## Priorisierte Produkt-Epics

1. Epic 1: Viewer Core Stabilitaet und Performance
2. Epic 2: Markup und Stamps Produktivbetrieb
3. Epic 5: Mobile, UX und Tablet
4. Epic 3: Output und Distribution (PDF zuerst)
5. Epic 4: Versionierung und Blattwechsel
6. Epic 6: Pruefung und Workflow mit ACC Issues (spaeter)

---

## Epic 1: Viewer Core Stabilitaet und Performance

Ziel:
Eine stabile und schnelle Basis fuer alle Folgefunktionen schaffen.

Scope:
- APS OAuth Login, Session und Token-Refresh robust machen
- Hub-, Projekt-, Ordner-, Datei- und Versionsnavigation stabilisieren
- Fehlerhandling bei API-, Netzwerk- und Sessionfehlern verbessern

Out of Scope:
- Fachlogik fuer Prueffreigaben
- PDF-Export und E-Mail-Versand

Akzeptanzkriterien:
- Modell-/Dokumentladequote >= 98 Prozent bei gueltigem Zugriff
- Keine reproduzierbaren Session-Abbrueche im Standardablauf
- Fehler sind im UI verstaendlich und handhabbar

Metriken:
- Time-to-First-Model
- Auth-Fehlerquote
- API-Fehlerquote fuer Navigationsendpunkte

---

## Epic 2: Markup und Stamps Produktivbetrieb

Ziel:
Stempel als verlaessliches Kernwerkzeug fuer 2D/3D etablieren.

Scope:
- Stempelbibliothek stabil laden und nutzbar machen
- Platzieren, Auswaehlen, Verschieben, Skalieren, Rotieren und Loeschen stabil betreiben
- Persistenz pro Kontext (hubId, projectId, itemId, versionId) sicherstellen

Out of Scope:
- Vollstaendige ACC-Issue-Orchestrierung
- Ergebnisverteilung per PDF/ACC-Upload/E-Mail

Akzeptanzkriterien:
- Wiederherstellung gespeicherter Stempel nach Reload >= 99 Prozent
- Kein Datenverlust bei normaler Bearbeitung
- Mehrfachauswahl und Eigenschaftsaenderung funktionieren konsistent

Metriken:
- Restore-Quote gespeicherter Stempel
- Fehlerquote bei Stamp-Aktionen
- Anzahl Supportfaelle zu verlorenen Markups

---

## Epic 3: Mobile, UX und Tablet

Ziel:
Robuste Bedienung fuer Baustelle und Besprechung sicherstellen.

Scope:
- Tablet-first Kernworkflow (oeffnen, markieren, speichern, exportieren)
- Touch-Interaktionen fuer Stempelbearbeitung verbessern
- Fokus auf robuste Bedienung im Baustellenkontext statt reiner Viewport-Optimierung

Out of Scope:
- Native Mobile App
- Offline-Modus (siehe Epic D fuer Offline-Sync)

Akzeptanzkriterien:
- Kernworkflow auf Tablet ohne Maus voll nutzbar
- Keine kritischen UI-Ueberlagerungen auf Zielgeraeten

Metriken:
- Tablet-Abbruchrate im Workflow
- Zeit pro Kernaufgabe auf Tablet
- UX-bezogene Fehlermeldungen pro Release

---

## Epic 4: Output und Distribution (PDF zuerst)

Ziel:
Das wichtigste Endresultat schnell liefern: verteilbares PDF aus dem Pruefstand.

Scope:
- PDF aus aktueller Pruefansicht erzeugen (inkl. Markups und Stamps)
- Bemassungs-Masstab im PDF ueber Messen ergaenzen (wie im ACC Viewer)
- Ergebnis nach ACC hochladen (Projektordner oder definierter Ablagepfad)
- Optionaler Versand per E-Mail (Anhang oder ACC-Link)

Out of Scope:
- Vollstaendiges DMS
- Komplexe externe Signaturprozesse

Akzeptanzkriterien:
- PDF-Erzeugung fuer Standardplaene reproduzierbar und performant
- ACC-Upload inkl. Metadaten (Projekt, Version, Ersteller, Zeit) stabil
- E-Mail-Versand mit nachvollziehbarem Status (sent, failed, retry)

Metriken:
- Zeit von Markup bis exportiertem PDF
- Erfolgsquote PDF-Erzeugung
- Erfolgsquote ACC-Upload
- Erfolgsquote E-Mail-Versand

---

## Epic 5: Versionierung und Blattwechsel

Ziel:
Kontextsicheres Arbeiten zwischen Versionen und Blaettern ohne Informationsverlust.

Scope:
- Blattwechsel in 2D ohne Kontextverlust
- Versionen vergleichbar machen und Zuordnung transparent halten
- Nachvollziehbarkeit je Version verbessern

Out of Scope:
- Geometrischer CAD-Diff auf Expertenniveau
- Historische BI-Auswertung

Akzeptanzkriterien:
- Versionswechsel ohne manuellen Reset von Arbeitskontext
- Eindeutige Zuordnung von Stempeln und spaeter Issues zur Dokumentversion
- Keine stillen Kontextspruenge im Workflow

Metriken:
- Fehlerquote bei Kontextwechsel
- Zeit fuer Version wechseln und weiterarbeiten
- Anteil korrekt zugeordneter Daten je Version

---

## Epic 6: Pruefung und Workflow mit ACC Issues (spaeter)

Ziel:
Stempel robust in ACC-Issues ueberfuehren, sobald PDF/Distribution stabil sind.

Scope:
- Stempel zu ACC-Issues umwandeln (inkl. Subtype-Validierung)
- Robustes Verhalten bei tenant-spezifischen ACC-Markup-Einschraenkungen
- Klare Rueckmeldungen fuer Success, Warning und Error

Out of Scope:
- Vollautomatische Eskalationsketten
- Erweiterte externe Freigabeworkflows

Akzeptanzkriterien:
- Erfolgsquote Issue-Erstellung >= 95 Prozent bei gueltigem Kontext
- Warnpfade sind nachvollziehbar und ohne harte Abbrueche

Metriken:
- Erfolgsquote /api/issues/create
- Anteil Warning-Faelle gegenueber Hard Errors
- Zeit von Markup bis erstelltem ACC-Issue

---

## Querschnitts-Epics

### Epic A: Security und Permissions

Ziel:
Sichere und klare Zugriffsstrukturen auf Basis der ACC-Projektvorlage.

Scope:
- ACC-Projektvorlage definiert Rollen und Zugriffe verbindlich vorab
- Benutzer haben in ACC eine lesbare Ordnerstruktur nach Vorgabe (ELIN ACC Vorlage) wo die lese/schreib Rechte haben
- API-Endpunkte und Session-Handling sicher betreiben

Akzeptanzkriterien:
- Keine privilegierte Aktion ohne passende Berechtigung
- Ablagestruktur und Schreibrechte sind fuer Zielrollen produktiv nutzbar

### Epic B: Reliability und Observability

Ziel:
Stoerungen schnell erkennen, eingrenzen und beheben.

Scope:
- Strukturierte Logs fuer Client und Server
- Monitoring fuer Auth, Laden, PDF, Upload, Versand und Issues
- Retry-Strategien bei transienten Fehlern

Akzeptanzkriterien:
- Standardfehler in kurzer Zeit triagierbar
- Reproduzierbare Ausfaelle im Monitoring sichtbar

### Epic C: Datenqualitaet und Nachvollziehbarkeit

Ziel:
Konsistente Kontexte und revisionssichere Entscheidungen ueber den gesamten Ablauf.

Scope:
- Konsistente IDs und Kontexte (hubId, projectId, itemId, versionId)
- Nachvollziehbare Historie fuer Pruefentscheidungen und Exporte

Akzeptanzkriterien:
- Keine stillen Kontextmischungen zwischen Dokumenten/Versionen
- Pruefentscheidungen sind dokumentiert und rueckverfolgbar

### Epic D: Offline-Field-Workflow und Synchronisation

Ziel:
Auf der Baustelle ohne Netz arbeiten und Ergebnisse sicher nach Reconnect synchronisieren.

Scope:
- Lokale Speicherung (IndexedDB) von Stempeln, Metadaten und PDF-Exports
- Offline-PDF-Erzeugung und lokale Verfuegbarkeit
- Job-Queue fuer ACC-Upload, E-Mail und Issues mit Status-Verfolgung
- Sync-Engine mit idempotenten Operationen und Konfliktaufloesung
- UI-Badges fuer Online, Offline, Sync-lauft, Sync-Fehler

Out of Scope:
- Vollstaendige ACC-Funktionalitaet offline
- Echtzeit-Kollaboration ohne Verbindung

Akzeptanzkriterien:
- Ohne Netz: oeffnen, markieren, speichern, PDF erzeugen funktioniert vollstaendig
- Nach Netzrueckkehr werden Queue-Aktionen zuverlassig synchronisiert
- Konflikte sind sichtbar und werden nicht still verloren
- Sync-Status ist fuer Nutzer deutlich erkennbar

Metriken:
- Offline-Session-Erfolgsquote
- Sync-Erfolgsquote beim Reconnect
- Konfliktrate pro 100 Sync-Vorgaenge
- Zeit vom Reconnect bis alle Aktionen synchronisiert

