# ELIN Viewer Roadmap

## Produktbereiche

1. Viewer Core
2. Markup & Stamps
3. Output & Distribution
4. Versionierung & Blattwechsel
5. Mobile / UX / Tablet
6. Pruefung & Workflow

## Zielbild

Der ELIN Viewer ist die zentrale Pruef- und Kollaborationsflaeche fuer 2D/3D-Modelle in ACC. Nutzer sollen schnell markieren, nachvollziehbar pruefen, eindeutig versionieren und Ergebnisse sicher verteilen koennen (inkl. PDF-Export, ACC-Upload und E-Mail-Versand).

## Phasenplanung (Now / Next / Later)

### NOW (0-1 Monate)

#### 1) Viewer Core
- Stabiler Login-/Token-Flow fuer APS/ACC
- Schnelle Ladezeiten fuer Hubs, Projekte, Inhalte und Versionen
- Solides Fehlerhandling bei API-Fehlern und Session-Ablauf

Definition of Done:
- Erfolgsquote Modell-Laden >= 98%
- Kein Blocker bei Token-Refresh in Standard-Workflows

#### 2) Markup & Stamps
- Stempelbibliothek produktiv nutzbar in 2D und 3D
- Platzieren, Verschieben, Skalieren, Rotieren und Loeschen stabil
- Persistenz ueber Server (`data/stamps`) pro Dokument-/Versionskontext

Definition of Done:
- Wiederherstellung gespeicherter Stempel nach Reload >= 99%
- Keine Datenverluste bei normalem Bearbeiten

#### 3) Output & Distribution
- PDF aus aktueller Pruefansicht erzeugen (inkl. Markups/Stempel)
- Bemassungs-Masstab im PDF ueber Messen ergaenzen (wie im ACC Viewer)
- Ergebnis direkt nach ACC hochladen und optional per E-Mail versenden

Definition of Done:
- PDF-Erzeugung fuer Standardplaene reproduzierbar und performant
- Upload nach ACC inkl. Metadaten (Projekt, Version, Ersteller) stabil
- E-Mail-Versand mit nachvollziehbarem Versandstatus

### NEXT (1-3 Monate)

#### 4) Versionierung & Blattwechsel
- Vergleich zwischen Dokumentversionen vereinfachen
- Blattwechsel in 2D ohne Kontextverlust (Issue/Stempel-Kontext beibehalten)
- Nachvollziehbarkeit: Wer hat wann in welcher Version geprueft

Definition of Done:
- Versionswechsel ohne manuellen Reset von Arbeitskontext
- Eindeutige Zuordnung von Stempeln/Issues zur Dokumentversion

#### 5) Mobile / UX / Tablet
- Tablet-first Bedienung fuer Baustelle/Besprechung
- Touch-Interaktionen fuer Stempelbearbeitung verbessern
- Fokus auf robuste Bedienung im Baustellenkontext statt reiner Viewport-Optimierung

Definition of Done:
- Kernworkflow auf Tablet ohne Maus voll nutzbar
- Keine kritischen UI-Ueberlagerungen bei gaengigen Aufloesungen

### LATER (3-4 Monate)

#### 6) Pruefung & Workflow
- Stempel zu ACC-Issues umwandeln (inkl. Subtype-Validierung)
- Robustes Verhalten bei tenant-spezifischen Markup-Einschraenkungen
- Klare Rueckmeldungen fuer Success/Warnung/Fehler

Definition of Done:
- Erfolgreiche Issue-Erstellung bei gueltigem Kontext >= 95%
- Warnpfade sind nachvollziehbar und ohne harte Abbrueche

## Querschnittsthemen

Diese Themen gelten fuer alle Produktbereiche und sollten kontinuierlich mitlaufen.

### Security & Permissions
- ACC-Projektvorlage definiert Rollen und Zugriffe verbindlich vorab
- Benutzer haben in ACC eine lesbare Ordnerstruktur nach Vorgabe (ELIN ACC Vorlage) wo die lese/schreib Rechte haben
- Sichere API-Endpoints und Session-Handling

### Reliability & Observability
- Strukturierte Logs fuer Client und Server
- Monitoring fuer Fehlerquoten in Auth, Laden, Issue-Erstellung, Upload und Versand
- Retry-Strategien bei transienten ACC-Fehlern

### Offline & Synchronisation
- Lokale IndexedDB Speicherung fuer Loesungen ohne Netz
- Job-Queue mit Sync-Engine beim Reconnect
- Robuste Konfliktaufloesung und Status-Anzeige

### Datenqualitaet & Nachvollziehbarkeit
- Konsistente IDs/Kontexte (hubId, projectId, itemId, versionId)
- Revisionssichere Historie fuer Pruefentscheidungen

## Priorisierte Outcomes

1. PDF als wichtigstes Endresultat schnell und reproduzierbar bereitstellen
2. Ergebnisse direkt in ACC hochladen und bei Bedarf per E-Mail verteilen
3. Hoehere Prozesssicherheit (weniger Kontext-/Sync-Fehler)
4. Bessere Nutzbarkeit auf Tablet und in Meetings
5. ACC-Issue-Workflow als nachgelagerte Ausbaustufe

## Messgroessen (Vorschlag)

- Time-to-First-Markup
- Zeit von Markup bis exportiertem PDF
- Erfolgsquote PDF-Erzeugung
- Erfolgsquote ACC-Upload und E-Mail-Versand
