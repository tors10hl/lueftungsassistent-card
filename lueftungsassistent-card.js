/* Lüftungsassistent Card
 * Home Assistant custom Lovelace card
 * v1.0.0
 */
const CARD_VERSION = "1.0.0";

class LueftungsassistentCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = this._defaultConfig();
    this._hass = null;
    this._data = null;
    this._refreshTimer = null;
    this._boundRender = () => this._scheduleRender();
  }

  _defaultConfig() {
    return {
      type: "custom:lueftungsassistent-card",
      outside_temperature: "",
      min_delta: 2,
      columns: 3,
      show_floor_titles: true,
      show_recommendation: true,
      show_window_count: true,
      show_outside_temperature: true,
      floor_order: "high_to_low",
      title: "Lüftungsassistent",
    };
  }

  setConfig(config) {
    if (!config || typeof config !== "object") {
      throw new Error("Invalid configuration");
    }
    this._config = { ...this._defaultConfig(), ...config };
    this._scheduleRender();
  }

  set hass(hass) {
    this._hass = hass;
    this._scheduleRender();
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    this._startRefresh();
    this._scheduleRender();
  }

  disconnectedCallback() {
    this._stopRefresh();
  }

  _startRefresh() {
    this._stopRefresh();
    // Registry/label changes are not necessarily state changes.
    // Refreshing periodically keeps the card dynamic when areas, floors or labels change.
    this._refreshTimer = setInterval(() => this._loadRegistryData(true), 30000);
  }

  _stopRefresh() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  _scheduleRender() {
    if (this._renderPending) return;
    this._renderPending = true;
    queueMicrotask(async () => {
      this._renderPending = false;
      await this._loadRegistryData(false);
      this._render();
    });
  }

  async _ws(type) {
    if (!this._hass?.callWS) return null;
    try {
      return await this._hass.callWS({ type });
    } catch (err) {
      console.warn(`lueftungsassistent-card: ${type} failed`, err);
      return null;
    }
  }

  async _loadRegistryData(force = false) {
    if (!this._hass?.callWS || !this._config.outside_temperature) return;

    const now = Date.now();
    if (!force && this._registry && now - this._registryAt < 5000) return;

    const [entityResult, areaResult, floorResult, labelResult] = await Promise.all([
      this._ws("config/entity_registry/list"),
      this._ws("config/area_registry/list"),
      this._ws("config/floor_registry/list"),
      this._ws("config/label_registry/list"),
    ]);

    // Home Assistant returns registry lists wrapped in an object:
    // { entities: [...] }, { areas: [...] }, { floors: [...] }, { labels: [...] }.
    const entities = entityResult?.entities || [];
    const areas = areaResult?.areas || [];
    const floors = floorResult?.floors || [];
    const labels = labelResult?.labels || [];

    if (!entities.length && !areas.length && !floors.length && !labels.length) return;

    this._registry = { entities, areas, floors, labels };
    this._registryAt = now;
    this._data = this._buildRooms();
  }

  _buildRooms() {
    const r = this._registry;
    if (!r) return [];

    const labelByName = new Map(
      r.labels.map(l => [String(l.name).trim().toLowerCase(), l.label_id])
    );
    const tempLabelId = labelByName.get("lueftung_hauptsensor");
    const windowLabelId = labelByName.get("fenster");

    if (!tempLabelId || !windowLabelId) return [];

    const areasById = new Map(r.areas.map(a => [a.area_id, a]));
    const floorsById = new Map(r.floors.map(f => [f.floor_id, f]));

    const entitiesByArea = new Map();
    for (const e of r.entities) {
      if (!e.area_id) continue;
      if (!entitiesByArea.has(e.area_id)) entitiesByArea.set(e.area_id, []);
      entitiesByArea.get(e.area_id).push(e);
    }

    const rooms = [];
    for (const [areaId, area] of areasById) {
      const areaEntities = entitiesByArea.get(areaId) || [];
      const tempSensors = areaEntities.filter(e => e.labels?.includes(tempLabelId));
      const windows = areaEntities.filter(e => e.labels?.includes(windowLabelId));

      if (!tempSensors.length || !windows.length) continue;

      // Same behavior as the user's working dashboard: first matching main sensor.
      const temp = tempSensors[0];
      const floor = area.floor_id ? floorsById.get(area.floor_id) : null;

      rooms.push({
        areaId,
        areaName: area.name || "Unbenannter Raum",
        floorId: area.floor_id || null,
        floorName: floor?.name || "Ohne Etage",
        floorLevel: Number.isFinite(Number(floor?.level)) ? Number(floor.level) : -9999,
        tempEntity: temp.entity_id,
        windowEntities: windows.map(w => w.entity_id),
      });
    }

    return rooms;
  }

  _sortedGroups() {
    const rooms = this._data || [];
    const groups = new Map();

    for (const room of rooms) {
      const key = room.floorId || "__no_floor__";
      if (!groups.has(key)) {
        groups.set(key, {
          id: key,
          name: room.floorName,
          level: room.floorLevel,
          rooms: [],
        });
      }
      groups.get(key).rooms.push(room);
    }

    for (const g of groups.values()) {
      g.rooms.sort((a, b) => a.areaName.localeCompare(b.areaName, "de"));
    }

    const groupsArray = [...groups.values()];
    const highToLow = this._config.floor_order !== "low_to_high";
    groupsArray.sort((a, b) => {
      if (a.id === "__no_floor__") return 1;
      if (b.id === "__no_floor__") return -1;
      return highToLow ? b.level - a.level : a.level - b.level;
    });

    return groupsArray;
  }

  _state(entityId) {
    return this._hass?.states?.[entityId];
  }

  _formatTemp(entityId) {
    const s = this._state(entityId);
    if (!s) return "—";
    const n = Number(s.state);
    if (!Number.isFinite(n)) return s.state;
    const unit = s.attributes?.unit_of_measurement || "°C";
    return `${n.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`;
  }

  _numeric(entityId) {
    const s = this._state(entityId);
    const n = Number(s?.state);
    return Number.isFinite(n) ? n : null;
  }

  _roomStatus(room) {
    const inside = this._numeric(room.tempEntity);
    const outside = this._numeric(this._config.outside_temperature);
    const delta = Number(this._config.min_delta) || 0;

    if (inside == null || outside == null) {
      return { useful: false, unknown: true, text: "Keine Daten" };
    }

    const useful = inside - outside >= delta;
    return {
      useful,
      unknown: false,
      text: useful ? "↑ Lüften lohnt sich" : "Kein Lüftungsvorteil",
    };
  }

  _windowInfo(room) {
    const states = room.windowEntities
      .map(id => this._state(id))
      .filter(Boolean);

    const total = states.length;
    const open = states.filter(s => s.state === "on").length;
    const unavailable = states.filter(
      s => s.state === "unavailable" || s.state === "unknown"
    ).length;

    return { total, open, unavailable };
  }

  _escape(text) {
    return String(text ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  _render() {
    if (!this.shadowRoot) return;

    const c = this._config;
    const outside = this._formatTemp(c.outside_temperature);
    const groups = this._sortedGroups();

    const css = `
      :host {
        display: block;
        --la-card-radius: 18px;
        --la-gap: 12px;
      }

      ha-card {
        overflow: hidden;
        border-radius: var(--ha-card-border-radius, 18px);
      }

      .wrap {
        padding: 16px;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 16px;
      }

      .title {
        font-size: 20px;
        font-weight: 650;
        color: var(--primary-text-color);
        line-height: 1.2;
      }

      .outside {
        color: var(--secondary-text-color);
        font-size: 14px;
        white-space: nowrap;
      }

      .outside strong {
        color: var(--primary-text-color);
        font-size: 16px;
      }

      .floor {
        margin-top: 16px;
      }

      .floor:first-child {
        margin-top: 0;
      }

      .floor-title {
        color: var(--secondary-text-color);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: .08em;
        text-transform: uppercase;
        margin: 0 0 8px 2px;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(var(--la-columns), minmax(0, 1fr));
        gap: var(--la-gap);
      }

      .room {
        min-width: 0;
        min-height: 145px;
        padding: 14px;
        box-sizing: border-box;
        border-radius: var(--la-card-radius);
        background: var(--ha-card-background, var(--card-background-color));
        border: 1px solid var(--divider-color);
        cursor: pointer;
        transition: transform .12s ease, border-color .12s ease;
      }

      .room:active {
        transform: scale(.985);
      }

      .room:hover {
        border-color: var(--outline-color, var(--divider-color));
      }

      .room-name {
        font-size: 15px;
        font-weight: 600;
        color: var(--primary-text-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .temp {
        margin-top: 13px;
        font-size: 29px;
        line-height: 1.1;
        font-weight: 650;
        color: var(--primary-text-color);
      }

      .temp.useful {
        color: var(--success-color);
      }

      .recommendation {
        margin-top: 6px;
        font-size: 13px;
        color: var(--secondary-text-color);
      }

      .recommendation.useful {
        color: var(--success-color);
        font-weight: 600;
      }

      .windows {
        margin-top: 12px;
        padding-top: 9px;
        border-top: 1px solid var(--divider-color);
        font-size: 13px;
        color: var(--secondary-text-color);
      }

      .windows.open {
        color: var(--warning-color);
        font-weight: 600;
      }

      .windows.offline {
        color: var(--error-color);
        font-weight: 600;
      }

      .empty {
        color: var(--secondary-text-color);
        padding: 8px 2px;
        font-size: 14px;
      }

      @media (max-width: 700px) {
        .wrap { padding: 12px; }
        .header { align-items: flex-start; }
        .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }

      @media (max-width: 480px) {
        .header { flex-direction: column; gap: 4px; }
        .grid { grid-template-columns: 1fr; }
        .room { min-height: 135px; }
      }
    `;

    let content = `
      <style>${css}</style>
      <ha-card>
        <div class="wrap">
          <div class="header">
            <div class="title">${this._escape(c.title)}</div>
            ${c.show_outside_temperature
              ? `<div class="outside">Außen <strong>${this._escape(outside)}</strong></div>`
              : ""}
          </div>
    `;

    if (!groups.length) {
      content += `
        <div class="empty">
          Keine Räume gefunden. Prüfe die Labels
          „Lueftung_Hauptsensor“ und „Fenster“.
        </div>
      `;
    } else {
      for (const group of groups) {
        content += `<section class="floor">`;

        if (c.show_floor_titles) {
          content += `<div class="floor-title">${this._escape(group.name)}</div>`;
        }

        content += `<div class="grid" style="--la-columns:${Math.max(1, Math.min(6, Number(c.columns) || 3))}">`;

        for (const room of group.rooms) {
          const status = this._roomStatus(room);
          const windows = this._windowInfo(room);

          let windowText = "";
          let windowClass = "windows";

          if (windows.unavailable > 0) {
            windowClass += " offline";
            windowText = `⚠ ${windows.unavailable} offline · ${windows.total} Fenster`;
          } else if (windows.open > 0) {
            windowClass += " open";
            windowText = `🪟 ${windows.open} offen · ${windows.total} Fenster`;
          } else {
            windowText = `🔒 alle zu · ${windows.total} Fenster`;
          }

          content += `
            <div class="room" data-entity="${this._escape(room.tempEntity)}">
              <div class="room-name">${this._escape(room.areaName)}</div>
              <div class="temp ${status.useful ? "useful" : ""}">
                ${this._escape(this._formatTemp(room.tempEntity))}
              </div>
              ${c.show_recommendation
                ? `<div class="recommendation ${status.useful ? "useful" : ""}">
                     ${this._escape(status.text)}
                   </div>`
                : ""}
              ${c.show_window_count
                ? `<div class="${windowClass}">${this._escape(windowText)}</div>`
                : ""}
            </div>
          `;
        }

        content += `</div></section>`;
      }
    }

    content += `</div></ha-card>`;

    this.shadowRoot.innerHTML = content;

    this.shadowRoot.querySelectorAll(".room").forEach(el => {
      el.addEventListener("click", () => {
        const entityId = el.dataset.entity;
        if (!entityId) return;

        // Native Home Assistant more-info event; no Browser Mod required.
        this.dispatchEvent(
          new CustomEvent("hass-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId },
          })
        );
      });
    });
  }

  getCardSize() {
    const groups = this._sortedGroups();
    return Math.max(3, groups.length * 3 + 2);
  }

  static getConfigElement() {
    return document.createElement("lueftungsassistent-card-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:lueftungsassistent-card",
      outside_temperature: "",
      min_delta: 2,
      columns: 3,
      show_floor_titles: true,
      show_recommendation: true,
      show_window_count: true,
      show_outside_temperature: true,
      floor_order: "high_to_low",
      title: "Lüftungsassistent",
    };
  }
}

class LueftungsassistentCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._form = null;
  }

  setConfig(config) {
    this._config = { ...LueftungsassistentCard.getStubConfig(), ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; }
        ha-form { display:block; }
      </style>
      <ha-form></ha-form>
    `;

    this._form = this.shadowRoot.querySelector("ha-form");
    this._form.hass = this._hass;
    this._form.data = this._config;

    this._form.schema = [
      {
        name: "outside_temperature",
        required: true,
        selector: {
          entity: {
            domain: ["sensor"],
            device_class: ["temperature"],
          },
        },
      },
      {
        name: "min_delta",
        selector: {
          number: {
            min: 0,
            max: 20,
            step: 0.5,
            mode: "box",
            unit_of_measurement: "°C",
          },
        },
      },
      {
        name: "columns",
        selector: {
          number: {
            min: 1,
            max: 6,
            step: 1,
            mode: "slider",
          },
        },
      },
      {
        name: "title",
        selector: {
          text: {},
        },
      },
      {
        name: "show_floor_titles",
        selector: { boolean: {} },
      },
      {
        name: "show_recommendation",
        selector: { boolean: {} },
      },
      {
        name: "show_window_count",
        selector: { boolean: {} },
      },
      {
        name: "show_outside_temperature",
        selector: { boolean: {} },
      },
      {
        name: "floor_order",
        selector: {
          select: {
            options: [
              { value: "high_to_low", label: "Höhere Etagen zuerst" },
              { value: "low_to_high", label: "Niedrigere Etagen zuerst" },
            ],
          },
        },
      },
    ];

    this._form.computeLabel = (schema) => ({
      outside_temperature: "Außentemperatur-Sensor",
      min_delta: "Mindestdifferenz zum Lüften",
      columns: "Spalten",
      title: "Titel",
      show_floor_titles: "Etagen anzeigen",
      show_recommendation: "Lüftungsempfehlung anzeigen",
      show_window_count: "Fensterstatus anzeigen",
      show_outside_temperature: "Außentemperatur anzeigen",
      floor_order: "Reihenfolge der Etagen",
    }[schema.name] || schema.name);

    this._form.addEventListener("value-changed", ev => {
      ev.stopPropagation();
      const newConfig = { ...this._config, ...ev.detail.value };
      this._config = newConfig;

      this.dispatchEvent(new CustomEvent("config-changed", {
        bubbles: true,
        composed: true,
        detail: { config: newConfig },
      }));
    });
  }
}

if (!customElements.get("lueftungsassistent-card")) {
  customElements.define("lueftungsassistent-card", LueftungsassistentCard);
}
if (!customElements.get("lueftungsassistent-card-editor")) {
  customElements.define("lueftungsassistent-card-editor", LueftungsassistentCardEditor);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "lueftungsassistent-card",
  name: "Lüftungsassistent Card",
  description: "Dynamische Lüftungsübersicht nach Etage und Raum.",
  preview: true,
});

console.info(
  `%c Lueftungsassistent Card %c v${CARD_VERSION} `,
  "color:white;background:#1976d2;font-weight:bold",
  "color:#1976d2;background:white;font-weight:bold"
);
