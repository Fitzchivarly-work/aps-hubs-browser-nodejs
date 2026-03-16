# ELIN Viewer - Progress Control

Stand: 2026-03-16

## Executive Summary

Der ELIN Viewer befindet sich in der **NOW-Phase** mit fokussierter Entwicklung auf die Kernfunktionalität. Phase 1 der Tablet-UI und einer aktualisierten Dokumentation wurde abgeschlossen (Meilenstein `milestone-2026-03-16-tablet-ui-readme`). Die nächste Priorität liegt auf stabiler PDF-Erzeugung und ACC-Integration.

---

## Roadmap Status nach Phasen

### NOW-Phase (0-1 Monate) - Aktuell

| Epic | Status | Completion | Nächster Schritt |
|------|--------|------------|------------------|
| Epic 1: Viewer Core | 🟡 In Progress | 85% | Session/Token-Stabilität final testen, Error-Handling vervollständigen |
| Epic 2: Markup & Stamps | 🟢 Stable | 95% | Serverseitige Persistenz finalisieren, Lasttest durchführen |
| Epic 3: Mobile / UX / Tablet | 🟢 Stable | 90% | Tablet-Workflow endnutzer-validieren |
| Epic 4: Output & Distribution | 🔴 Not Started | 0% | PDF-Engine evaluieren, Design festlegen |

### NEXT-Phase (1-3 Monate) - Planung

| Epic | Status | Completion | Abhängigkeiten |
|------|--------|------------|-----------------|
| Epic 5: Versionierung & Blattwechsel | 🔴 Not Started | 0% | Epic 1, 2, 3 müssen stabil sein |
| Epic 6: Prüfung & Workflow (Issues) | 🔴 Not Started | 0% | Epic 4 (PDF), Epic 3, Querschnitts-Epic A |

### LATER-Phase (4-8 Monate) - Roadmap

| Epic | Status | Completion | Abhängigkeiten |
|------|--------|------------|-----------------|
| Epic D: Offline & Sync | 🔴 Not Started | 0% | Epic 4, Epic 1, Querschnitts-Epic B |

### Querschnitts-Epics (kontinuierlich)

| Epic | Status | Completion | Fokus |
|------|--------|------------|-------|
| Epic A: Security & Permissions | 🟡 In Progress | 40% | ACC-Projektvorlage + Rollen definieren |
| Epic B: Reliability & Observability | 🟡 In Progress | 50% | Logs, Monitoring-Struktur, Error-Handling |
| Epic C: Datenqualität & Nachvollziehbarkeit | 🟡 In Progress | 60% | ID-Konsistenz, Kontext-Binding, Historie |

---

## Git Meilensteine

### Abgeschlossene Releases

| Tag | Datum | Focus | Commit |
|-----|-------|-------|--------|
| `milestone-2026-03-16-tablet-ui-readme` | 2026-03-16 | Tablet UI Fixes + dokumentation (README, Roadmap, Epics) | 078f364 |
| `milestone-2026-03-10-pretest` | 2026-03-10 | Pre-Test Checkpoint für Stamps und Persistenz | (älter) |
| `milestone-2026-03-10-central-stamp-storage` | 2026-03-10 | Zentrale Stamp-Ablage eingeführt | (älter) |

### Geplante Releases

| Target | Phase | Inhalte |
|--------|-------|---------|
| 2026-05-xx | Release 2 | Epic 4 (PDF), Epic 5 (Versionierung) stabil |
| 2026-07-xx | Release 3 | Epic 6 (ACC Issues), Epic D (Offline) |

---

## Key Performance Indicators (KPIs)

### Viewer Core (Epic 1)
- **Model-Load-Quote**: Target >= 98%, aktuell: __% (zu prüfen)
- **Auth-Fehlerquote**: Target < 2%, aktuell: __% (zu prüfen)
- **API-Fehlerquote Navigationsendpunkte**: Target < 1%, aktuell: __% (zu prüfen)

### Markup & Stamps (Epic 2)
- **Restore-Quote gespeicherter Stempel**: Target >= 99%, aktuell: 95% (stabil)
- **Fehlerquote Stamp-Aktionen**: Target < 1%, aktuell: < 1% (stabil)
- **Supportfälle zu verlorenen Markups**: Target = 0, aktuell: < 3 pro Monat

### Mobile / UX / Tablet (Epic 3)
- **Tablet-Abbruchrate im Workflow**: Target < 5%, aktuell: __% (in Validierung nach Milestone)
- **Time-per-Task Tablet vs. Desktop**: Target <= 1.5x, aktuell: __% (zu messen)
- **UX-Fehlermeldungen pro Release**: Target < 3, aktuell: neu gemessen nach Milestone

### Output & Distribution (Epic 4) - kommend
- **Zeit von Markup bis PDF**: Target < 5 Sekunden
- **PDF-Erzeugung Erfolgsquote**: Target >= 99%
- **ACC-Upload Erfolgsquote**: Target >= 98%
- **E-Mail-Versand Erfolgsquote**: Target >= 95%

### Überschnittliche KPIs
- **Durchschnittliche Fehlerquote über alle APIs**: Target < 1%
- **Retry-Erfolgsquote bei transienten Fehlern**: Target >= 95%
- **Offline Sync-Erfolgsquote** (später): Target >= 99%

---

## Ressourcen & Kapazität

### Team Zuweisung (Annahme)
- Frontend (ElinStampExtension.js, UI): 1-2 Entwickler
- Backend (server.js, Persistenz, APIs): 1 Entwickler
- Testing & QA: 0.5-1 Entwickler
- Product/Tech Lead: Oversight

### Abhängigkeiten zu Dritten
- Autodesk APS (OAuth, Data Management, Viewer): Cloud-Plattform
- Autodesk ACC (Issues, Markups, Files): Cloud-Service
- Node.js Runtime: Infrastruktur
- PDF-Engine (zu wählen für Epic 4): extern oder Bibliothek

---

## Known Issues & Blockers

### Hohe Priorität
1. **ACC-Tenant Markup-Endpunkt-Varianz**: Verschiedene Tenants unterstützen unterschiedliche Markup-Formate. Lösungsansatz: Feature-Flag basierte Fallbacks (vorhanden, siehe Epic D für Offline-Handling).
2. **2D-Daten URN-Format**: Nicht alle 2D-Dokumente folgen dm.lineage Standard. Lösungsansatz: Validierung und Fehlerbehandlung (in Arbeit für Epic 6).

### Mittere Priorität
3. **Session-Ablauf bei langen Feldarbeiten**: OAuth-Token können auf Baustelle ohne Netz ausgehen. Lösungsansatz: Epic D Offline-Queue mit Retry beim Reconnect.
4. **PDF-Library-Wahl**: Keine PDF-Engine bislang gewählt. Blocker für Epic 4 Start. Action: Evaluation pdfkit, pdf-lib, html2pdf etc.

### Backlog / Gering
5. **Performance bei 1000+ Stamps**: Große Stempel-Sammlungen können UI verlangsamen (Edge Case). Geplant für Post-Release-Optimization.

---

## Nächste Zweiwochen-Ziele (Sprint)

1. ✅ **Dokumentation finalisiert** (Roadmap, Epics, README)
   - Status: DONE (Milestone 2026-03-16)
   
2. 🔵 **PDF-Engine evaluiert und entschieden**
   - Scope: Vergleich pdfkit vs. pdf-lib für Baustellen-Anforderungen
   - Owner: Tech Lead
   - Target: 2026-03-30
   
3. 🔵 **Epic 4 Design & Prototyp**
   - Scope: Wireframes für PDF-Export, ACC-Upload-Flow, Mail-Dialog
   - Owner: Frontend Dev + UX
   - Target: 2026-03-31
   
4. 🔵 **Querschnitts-Epic A: ACC-Projektvorlage Draft**
   - Scope: Rollen- und Ablagestruktur definieren
   - Owner: Product/Tech Lead
   - Target: 2026-03-23
   
5. 🔵 **Epic 1 Final Test & Stabilisierung**
   - Scope: Session-Token-Refresh reproduzierbar testen, Error-Paths validieren
   - Owner: QA / DEV
   - Target: 2026-03-30

---

## Changelog

| Datum | Ereignis |
|-------|----------|
| 2026-03-16 | Meilenstein `milestone-2026-03-16-tablet-ui-readme`: Tablet UI Phase 1 + Dokumentation (README, Roadmap, Epics) abgeschlossen |
| 2026-03-12 | Phase 1 Tablet UI Fixes merged (Sidebar, Panel-Drag, Media-Queries angepasst) |
| 2026-03-10 | Pre-Test und zentrale Stamp-Speicherung stabilisiert |
| Früher | APS Hubs Browser Basis, erste Stamp-Extension, Persistenz über Backend |

---

## Nächste Review

- **Nächstes Planning**: 2026-03-30
- **Nächster Meilenstein Target**: 2026-05-xx (Release 2 mit PDF + Versionierung)
