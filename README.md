# Lüftungsassistent Card

Eine dynamische Lovelace Custom Card für Home Assistant.

## Funktionen

- findet Räume automatisch über `Lueftung_Hauptsensor`
- findet Fenster automatisch über `Fenster`
- gruppiert Räume nach Home-Assistant-Etagen
- keine Entity-IDs pro Raum
- Außentemperatur als einzige manuelle Entity
- Lüftungsempfehlung mit frei konfigurierbarer Mindestdifferenz
- responsive Darstellung
- visueller Lovelace-Editor
- kompatibel mit Dark Themes / iOS Dark Blue

## Installation über HACS

Für eine HACS-Installation muss der Inhalt dieses Pakets in ein eigenes GitHub-Repository
hochgeladen werden. Danach in HACS:

**HACS → Frontend → ⋮ → Benutzerdefiniertes Repository**

Repository als Typ **Dashboard** hinzufügen und anschließend die Karte installieren.

Die Datei:

`dist/lueftungsassistent-card.js`

wird dabei als Lovelace-Ressource eingebunden.

### Manuelle Installation

Alternativ `dist/lueftungsassistent-card.js` nach:

`/config/www/community/lueftungsassistent-card/`

kopieren und als Lovelace-Ressource laden.

## Konfiguration

Minimal:

```yaml
type: custom:lueftungsassistent-card
outside_temperature: sensor.temperatur_schattenseite_haus
```

Vollständig:

```yaml
type: custom:lueftungsassistent-card
outside_temperature: sensor.temperatur_schattenseite_haus
min_delta: 2
columns: 3
show_floor_titles: true
show_recommendation: true
show_window_count: true
show_outside_temperature: true
floor_order: high_to_low
title: Lüftungsassistent
```

## Labels

Ein Raum wird nur angezeigt, wenn:

1. mindestens ein Entity im Bereich das Label `Lueftung_Hauptsensor` besitzt
2. mindestens ein Entity im selben Bereich das Label `Fenster` besitzt

Der erste passende `Lueftung_Hauptsensor` wird wie im bisherigen Dashboard als Raumtemperatur verwendet.

## Hinweise

Die Karte liest Area-, Floor-, Label- und Entity-Registry über die Home-Assistant-WebSocket-API. Bei Änderungen an Bereichen, Etagen oder Labels wird die Registry spätestens nach 30 Sekunden neu eingelesen.
