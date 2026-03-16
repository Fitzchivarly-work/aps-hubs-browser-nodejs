# ELIN Viewer Teststrategie

Stand: 2026-03-16
Primaere Quelle: QA_Volltest_Checkliste.csv

## Ziel

Diese Teststrategie ueberfuehrt die bestehende Volltest-Checkliste in einen reproduzierbaren QA-Ablauf fuer Releases und Meilensteine des ELIN Viewers.

## Testumfang (aus Volltest-Checkliste)

Die aktuelle Volltest-Checkliste umfasst 20 Testfaelle (T01-T20) in diesen Bereichen:

- Basis und Bedienung (Stempel platzieren, Panel, Farbe, Liniendicke)
- Geometrie und Darstellung (Rotation, Text-Rotation, Text-Rahmen)
- Interaktion (Text-Drag, Multi-Select, Relative Lage)
- Persistenz und Kontext (Reload, Modellwechsel)
- ACC-Integration (Issue-Anlage, Payload-Validierung, Fehlerfall)
- Performance und Regression (2D/3D, Lasttest)
- Abnahme (Finale Freigabe)

## Testarten

### 1) Manuelle funktionale Tests (Pflicht)

Basis ist die vorhandene Checkliste T01-T20.

Pflicht vor jeder Freigabe:
- Alle BLOCKER/HOCH-Testfaelle muessen auf OK stehen.
- Keine regressiven NOKs in bereits freigegebenen Kernfunktionen.

### 2) Smoke-Tests (pro Build)

Minimalset fuer schnelle Build-Freigabe:
- T01 Stempel platzieren
- T02 Eigenschaften anzeigen
- T13 Persistenz Reload
- T15 ACC Export
- T17 Fehlerbehandlung ohne gueltigen Kontext

Ziel:
- In < 15 Minuten feststellen, ob Build testbar ist.

### 3) Regressions-Tests (pro Milestone)

Vollstaendiger Durchlauf T01-T20 mit Fokus auf:
- Bedienbarkeit 2D
- Persistenz pro Modellkontext
- ACC-Endpunkte und Fehlerrueckmeldungen
- 3D-Basischeck (T19)

### 4) Nicht-funktionale Kurztests

Leichtgewichtige NFR-Pruefung je Meilenstein:
- Performance-Schnelltest T18 (30-50 Stempel)
- Basis-Stabilitaet bei Session/Netzfehlern (T17)

## Priorisierung der Testfaelle

### Kritisch (Release-blockierend)

- T01, T02, T03, T06, T10, T12, T13, T14, T15, T17, T20

Regel:
- Bei NOK in diesen Faellen keine Freigabe.

### Hoch

- T04, T07, T08, T09, T11, T16, T19

Regel:
- Vor Produktionsfreigabe auf OK oder mit dokumentiertem Workaround inkl. Termin zur Behebung.

### Mittel/Niedrig

- T05, T18

Regel:
- Duerfen nur mit akzeptiertem Restrisiko in die Freigabe.

## Traceability zu Epics

- Epic 1 (Viewer Core): T17, Teile von T13/T14
- Epic 2 (Markup & Stamps): T01-T13, T18
- Epic 3 (Mobile/UX/Tablet): T02, T09, T10, T12 (zusaetzlich Tablet-spezifische Durchfuehrung)
- Epic 4 (Output & Distribution): nach Erweiterung um PDF/Upload/Versand um neue Testfaelle ergaenzen
- Epic 5 (Versionierung): T14 als Ausgangspunkt, spaeter Versionsvergleich erweitern
- Epic 6 (Issues): T15, T16, T17
- Epic D (Offline Sync): neue Testfaelle zusaetzlich erforderlich (offline speichern, queue, reconnect)

## Testumgebung

Mindestumfang je Testlauf:

- Browser: aktuelles Chrome (Pflicht), Edge (Soll)
- Viewer-Kontext: 2D-Dokument und 3D-Modell
- ACC: gueltiges Projekt mit aktivem Issue-Type/Subtype
- Benutzerrolle: Berechtigung fuer Lesen, Markieren und Issue-Erstellung

## Durchfuehrungsprozess

### Vor dem Lauf (Entry Criteria)

- Build ist deployt und ueber URL erreichbar.
- Login mit Testnutzer funktioniert.
- Referenzprojekt und Referenzdatei fuer 2D/3D sind bekannt.
- Offene BLOCKER aus vorigem Lauf sind behoben oder bewusst als BLOCKED dokumentiert.

### Waehren des Laufs

- Status pro Testfall pflegen: OFFEN, OK, NOK, BLOCKED.
- Ist-Ergebnis immer kurz dokumentieren.
- Bei NOK/BLOCKED Ticket/Link und Reproduktionshinweis eintragen.

### Nach dem Lauf (Exit Criteria)

Freigabe nur, wenn:
- Kein BLOCKER offen.
- Alle kritischen Testfaelle OK.
- Fuer verbleibende HOCH/MITTEL/NIEDRIG liegt Risikoentscheidung vor.

## Defect-Management

Schweregrade:

- BLOCKER: Keine Freigabe moeglich, Kernworkflow unbenutzbar.
- HOCH: Wesentliche Funktion stark eingeschraenkt, kurzfristiger Fix notwendig.
- MITTEL: Funktional nutzbar mit Einschrankung.
- NIEDRIG: Kosmetisch oder seltene Randbedingung.

Mindestinhalt pro Defect:

- Bezug auf Testfall-ID (z. B. T13)
- Reproduktionsschritte
- Ist- vs. Soll-Ergebnis
- Umgebung (2D/3D, Modell, Browser)
- Screenshot/Netzwerkhinweis wenn relevant

## Reporting-Template (pro Testlauf)

- Laufdatum:
- Build/Commit/Tag:
- Tester:
- Gesamt: X OK / Y NOK / Z BLOCKED / N OFFEN
- Kritische Faelle: X von Y OK
- Freigabeempfehlung: GO / NO-GO
- Top-3 Risiken:

## Naechste Erweiterungen der Checkliste

Die bestehende Datei ist eine starke Basis. Fuer kommende Epics bitte ergaenzen:

1. PDF-Qualitaet und PDF-Metadaten (Epic 4)
2. ACC-Upload und E-Mail-Versand End-to-End (Epic 4)
3. Versionierungsvergleich und Kontexttreue bei Blattwechsel (Epic 5)
4. Offline-Queue, Reconnect-Sync, Konfliktaufloesung (Epic D)
5. Tablet-spezifische Touch-Regressionen je Hauptworkflow (Epic 3)

## Referenz

- QA-Volltestbasis: `QA_Volltest_Checkliste.csv`
