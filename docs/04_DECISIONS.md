# ELIN Viewer Decisions (ADR)

Stand: 2026-03-16

Dieses Dokument sammelt die bisher gemeinsam getroffenen Produkt- und Architekturentscheidungen.

## ADR-001 - Priorisierung: PDF vor ACC Issues

- Status: Accepted
- Datum: 2026-03-16

Kontext:
- Das wichtigste Nutzerergebnis ist ein verteilbares Pruefergebnis.
- ACC-Issue-Workflows sind tenant-abhaengig und funktional variabel.

Entscheidung:
- Output & Distribution (PDF-Export, ACC-Upload, E-Mail) wird vor dem vollstaendigen Issues-Workflow umgesetzt.
- Der Issues-Ausbau folgt spaeter als eigener Ausbauschritt.

Begruendung:
- Schnellster Business-Mehrwert fuer Baustelle und Review-Meetings.
- Geringeres Risiko gegenueber tenant-spezifischen Issue/Markup-Unterschieden.

Konsequenzen:
- Epic 4 (Output) vor Epic 6 (Issues) priorisiert.
- KPI-Fokus zuerst auf PDF-Zeit und PDF-Erfolgsquote.

---

## ADR-002 - Mobile/Tablet als frueher Kern-Use-Case

- Status: Accepted
- Datum: 2026-03-16

Kontext:
- Zielnutzer arbeiten im Baustellen- und Besprechungskontext.
- Bedienbarkeit auf Touchgeraeten ist nicht optional.

Entscheidung:
- Mobile/UX/Tablet wird frueh priorisiert (vor breiter Workflow-Automatisierung).
- Kernworkflow muss ohne Maus robust bedienbar sein.

Begruendung:
- Direkter Einfluss auf Akzeptanz und reale Nutzbarkeit im Feld.

Konsequenzen:
- Tablet-spezifische UI/Interaktions-Qualitaet ist Release-Kriterium.
- Zusetzliche UX-Metriken (Abbruchrate, Task-Zeit) werden verbindlich verfolgt.

---

## ADR-003 - Persistenzmodell pro Dokument-/Versionskontext

- Status: Accepted
- Datum: 2026-03-16

Kontext:
- Stempel duerfen nicht zwischen Dokumenten/Versionen vermischt werden.

Entscheidung:
- Persistenz wird kontextgebunden umgesetzt mit hubId, projectId, itemId, versionId.
- Serverseitige Ablage in `data/stamps` bleibt vorerst Standard.

Begruendung:
- Eindeutige Zuordnung und reproduzierbare Wiederherstellung.

Konsequenzen:
- Stempel-Restore wird als zentrale Qualitaetsmetrik betrieben.
- Versionswechsel und Blattwechsel muessen Kontext strikt erhalten.

---

## ADR-004 - Offline-Strategie: Store-and-Sync statt Echtzeit-Offline-ACC

- Status: Accepted
- Datum: 2026-03-16

Kontext:
- Baustellenarbeit ohne stabile Verbindung ist realer Standardfall.
- ACC-Funktionen stehen offline nicht vollstaendig zur Verfuegung.

Entscheidung:
- Offline wird als Store-and-Sync-Architektur gebaut:
	- lokale IndexedDB Speicherung,
	- Job-Queue fuer Upload/E-Mail/Issue,
	- Synchronisation bei Reconnect mit Konfliktanzeige.

Begruendung:
- Realistisch umsetzbar unter ACC-Randbedingungen.
- Verhindert Datenverlust und stilles Scheitern im Feld.

Konsequenzen:
- Epic D als eigener Querschnitts-Epic aufgenommen.
- UI-Status fuer Online/Offline/Sync ist verpflichtend.

---

## ADR-005 - Security ueber ACC-Projektvorlage und Rollenmodell

- Status: Accepted
- Datum: 2026-03-16

Kontext:
- Zugriff und Ablage muessen organisatorisch und technisch konsistent sein.

Entscheidung:
- Security-Baseline erfolgt ueber ELIN ACC Projektvorlage (Rollen, Ordnerstruktur, lese/schreib Rechte).
- Anwendung erzwingt keine Umgehung von ACC-Berechtigungen.

Begruendung:
- Governance wird in ACC standardisiert und fuer Projekte wiederverwendbar.

Konsequenzen:
- Epic A ist verpflichtendes Querschnittsthema.
- Produktive Einfuehrung benoetigt abgestimmte Rollen-/Ordnerkonfiguration.

---

## ADR-006 - Reliability/Observability als Standard fuer alle Epics

- Status: Accepted
- Datum: 2026-03-16

Kontext:
- Auth-, API- und tenant-spezifische Fehlerbilder sind erwartbar.

Entscheidung:
- Strukturierte Logs, Monitoring und Retry-Strategien werden als Plattformstandard definiert.

Begruendung:
- Schnellere Fehleranalyse, stabilerer Betrieb, geringere Supportkosten.

Konsequenzen:
- Epic B und KPI-Tracking laufen parallel zur Feature-Umsetzung.
- Fehlerpfade muessen im UI nachvollziehbar bleiben (kein harter Abbruch ohne Rueckmeldung).

---

## ADR-007 - Regionale Viewer-Konfiguration EU

- Status: Accepted
- Datum: 2026-03-16

Kontext:
- Das Projekt arbeitet mit europaeischem ACC/APS-Kontext.

Entscheidung:
- Viewer wird mit EU-Endpunkt (`derivativeV2_EU`) betrieben.

Begruendung:
- Konsistente Datenlokation und kompatible Laufzeitkonfiguration.

Konsequenzen:
- Umgebung und Deployments muessen diese Regionalkonfiguration beibehalten.

---

## ADR-008 - Tenant-Variabilitaet bei Markup/Issue-Endpunkten

- Status: Accepted
- Datum: 2026-03-16

Kontext:
- Nicht alle ACC-Tenants unterstuetzen identische Markup-Endpunkte und Formate.

Entscheidung:
- Fallback- und Warnpfade sind Pflicht (Feature-Flags, alternative Flows, klare Meldungen).
- Issue-Erstellung und zusaetzlicher Markup-POST werden entkoppelt behandelt.

Begruendung:
- Erhoeht Robustheit zwischen unterschiedlichen Kundenumgebungen.

Konsequenzen:
- Hard-Fail wird wo moeglich durch kontrollierte Warnung + Retry ersetzt.
- Teststrategie muss Tenant-Varianten explizit abdecken.

---

## ADR-009 - Dokumentationsstruktur als Fuehrungsartefakt

- Status: Accepted
- Datum: 2026-03-16

Kontext:
- Strategie, Umsetzung und Steuerung muessen fuer Team und Stakeholder konsistent sein.

Entscheidung:
- Dokumentationssatz wird verbindlich genutzt:
	- `01_ROADMAP.md` fuer Richtung,
	- `02_EPICS.md` fuer Scope/Akzeptanz,
	- `03_PROGRESS_CONTROL.md` fuer Steuerung,
	- `04_DECISIONS.md` fuer verbindliche Entscheidungen,
	- `05_TESTS.md` fuer Qualitaetssicherung.

Begruendung:
- Einheitliche Entscheidungsbasis und klarer Projektbetrieb.

Konsequenzen:
- Aenderungen an Prioritaeten oder Architektur werden zuerst als ADR aktualisiert.

---

## Offene Entscheidungen (Pending)

### P-001 - PDF-Engine Auswahl
- Status: Pending
- Zieltermin: 2026-03-30
- Optionen: pdfkit, pdf-lib, browserbasierter Render-Ansatz
- Entscheidungskriterien: Layouttreue, Performance, Wartbarkeit, Integrationsaufwand

### P-002 - Versandstrategie E-Mail
- Status: Pending
- Zieltermin: 2026-03-30
- Optionen: SMTP direkt, API-Dienst, ACC-Link-only Versand
- Entscheidungskriterien: Security, Zustellbarkeit, Betriebsaufwand

### P-003 - Konfliktregel fuer Offline-Sync
- Status: Pending
- Zieltermin: vor Epic D Umsetzung
- Optionen: last-write-wins, nutzergefuehrte Aufloesung, objektbasierte Merge-Regeln
- Entscheidungskriterien: Nachvollziehbarkeit, Fehlerquote, UX-Verstaendlichkeit

