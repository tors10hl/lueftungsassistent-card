/* Lüftungsassistent Card
 * Home Assistant custom Lovelace card
 * v1.2.0
 */
const CARD_VERSION = "1.2.0";

class LueftungsassistentCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = this._defaultConfig();
    this._hass = null;
    this._data = [];
    this._registry = null;
    this._registryAt = 0;
    this._refreshTimer = null;
    this._renderPending = false;
    this._loading = false;
    this._loadError = null;
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
      throw new Error("Ungültige Konfiguration");
    }
    this._config = { ...this._defaultConfig(), ...config };
    this._registryAt = 0;
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
    this._refreshTimer = setInterval(() => {
      this._loadRegistryData(true).then(() => this._render());
    }, 30000);
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
    if (!this._hass?.callWS) {
      throw new Error("Home Assistant WebSocket API ist nicht verfügbar.");
    }
    return this._hass.callWS({ type });
  }

  _asArray(result, property) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.[property])) return result[property];
    return [];
  }

  async _loadRegistryData(force = false) {
    if (!this._hass?.callWS) {
      this._loadError = "Home Assistant ist noch nicht verfügbar.";
      return;
    }

    if (!this._config.outside_temperature) {
      this._loadError = "Kein Außentemperatur-Sensor konfiguriert.";
      this._data = [];
      return;
    }

    const now = Date.now();
    if (!force && this._registry && now - this._registryAt < 5000) return;
    if (this._loading) return;

    this._loading = true;
    this._loadError = null;

    try {
      const [entityResult, deviceResult, areaResult, floorResult, labelResult] =
        await Promise.all([
          this._ws("config/entity_registry/list"),
          this._ws("config/device_registry/list"),
          this._ws("config/area_registry/list"),
          this._ws("config/floor_registry/list"),
          this._ws("config/label_registry/list"),
        ]);

      const entities = this._asArray(entityResult, "entities");
      const devices = this._asArray(deviceResult, "devices");
      const areas = this._asArray(areaResult, "areas");
      const floors = this._asArray(floorResult, "floors");
      const labels = this._asArray(labelResult, "labels");

      if (!entities.length) {
        throw new Error("Die Entitätsregistrierung enthält keine Entitäten.");
      }
      if (!areas.length) {
        throw new Error("Die Raumregistrierung enthält keine Räume.");
      }
      if (!labels.length) {
        throw new Error("Die Label-Registrierung enthält keine Labels.");
      }

      this._registry = { entities, devices, areas, floors, labels };
      this._registryAt = now;
      this._data = this._buildRooms();
    } catch (err) {
      console.error("lueftungsassistent-card: Registry konnte nicht geladen werden", err);
      this._loadError = err?.message || "Registry-Daten konnten nicht geladen werden.";
      this._data = [];
    } finally {
      this._loading = false;
    }
  }

  _normalize(value) {
    return String(value ?? "")
      .trim()
      .toLocaleLowerCase("de-DE")
      .replaceAll("ä", "ae")
      .replaceAll("ö", "oe")
      .replaceAll("ü", "ue")
      .replaceAll("ß", "ss")
      .replace(/[\s-]+/g, "_");
  }

  _entityLabels(entity) {
    return Array.isArray(entity?.labels) ? entity.labels : [];
  }

  _buildRooms() {
    const r = this._registry;
    if (!r) return [];

    const labelsByNormalizedName = new Map();
    for (const label of r.labels) {
      labelsByNormalizedName.set(this._normalize(label.name), label.label_id);
      labelsByNormalizedName.set(this._normalize(label.label_id), label.label_id);
    }

    const tempLabelId = labelsByNormalizedName.get("lueftung_hauptsensor");
    const windowLabelId = labelsByNormalizedName.get("fenster");

    const missingLabels = [];
    if (!tempLabelId) missingLabels.push("Lueftung_Hauptsensor");
    if (!windowLabelId) missingLabels.push("Fenster");

    if (missingLabels.length) {
      this._loadError = `Label nicht gefunden: ${missingLabels.join(", ")}.`;
      console.warn("lueftungsassistent-card: verfügbare Labels", r.labels);
      return [];
    }

    const areasById = new Map(r.areas.map(area => [area.area_id, area]));
    const floorsById = new Map(r.floors.map(floor => [floor.floor_id, floor]));
    const devicesById = new Map(r.devices.map(device => [device.id, device]));
    const entitiesByArea = new Map();

    for (const entity of r.entities) {
      const device = entity.device_id ? devicesById.get(entity.device_id) : null;
      const effectiveAreaId = entity.area_id || device?.area_id || null;
      if (!effectiveAreaId || !areasById.has(effectiveAreaId)) continue;

      if (!entitiesByArea.has(effectiveAreaId)) {
        entitiesByArea.set(effectiveAreaId, []);
      }
      entitiesByArea.get(effectiveAreaId).push(entity);
    }

    const rooms = [];
    for (const [areaId, area] of areasById) {
      const areaEntities = entitiesByArea.get(areaId) || [];
      const tempSensors = areaEntities.filter(entity =>
        this._entityLabels(entity).includes(tempLabelId)
      );
      const windows = areaEntities.filter(entity =>
        this._entityLabels(entity).includes(windowLabelId)
      );

      if (!tempSensors.length || !windows.length) continue;

      const temp = tempSensors[0];
      const floor = area.floor_id ? floorsById.get(area.floor_id) : null;
      const level = Number(floor?.level);

      rooms.push({
        areaId,
        areaName: area.name || "Unbenannter Raum",
        floorId: area.floor_id || null,
        floorName: floor?.name || "Ohne Etage",
        floorLevel: Number.isFinite(level) ? level : -9999,
        tempEntity: temp.entity_id,
        windowEntities: windows.map(window => window.entity_id),
      });
    }

    if (!rooms.length) {
      this._loadError =
        "Keine passenden Räume gefunden. Jeder Raum benötigt einen Hauptsensor und mindestens einen Fenstersensor mit den vorgesehenen Labels. Die Entitäten oder ihre Geräte müssen demselben Raum zugeordnet sein.";
    }

    return rooms;
  }

  _sortedGroups() {
    const groups = new Map();

    for (const room of this._data || []) {
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

    for (const group of groups.values()) {
      group.rooms.sort((a, b) => a.areaName.localeCompare(b.areaName, "de"));
    }

    const result = [...groups.values()];
    const highToLow = this._config.floor_order !== "low_to_high";
    result.sort((a, b) => {
      if (a.id === "__no_floor__") return 1;
      if (b.id === "__no_floor__") return -1;
      return highToLow ? b.level - a.level : a.level - b.level;
    });

    return result;
  }

  _state(entityId) {
    return this._hass?.states?.[entityId];
  }

  _formatTemp(entityId) {
    const state = this._state(entityId);
    if (!state) return "—";

    const value = Number(state.state);
    if (!Number.isFinite(value)) return state.state;

    const unit = state.attributes?.unit_of_measurement || "°C";
    return `${value.toLocaleString("de-DE", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })} ${unit}`;
  }

  _numeric(entityId) {
    const value = Number(this._state(entityId)?.state);
    return Number.isFinite(value) ? value : null;
  }

  _roomStatus(room) {
    const inside = this._numeric(room.tempEntity);
    const outside = this._numeric(this._config.outside_temperature);
    const delta = Number(this._config.min_delta) || 0;

    if (inside == null || outside == null) {
      return { useful: false, unknown: true, text: "Keine Temperaturdaten" };
    }

    const useful = inside - outside >= delta;
    return {
      useful,
      unknown: false,
      text: useful ? "↑ Lüften lohnt sich" : "Kein Lüftungsvorteil",
    };
  }

  _windowInfo(room) {
    const states = room.windowEntities.map(id => this._state(id)).filter(Boolean);
    return {
      total: room.windowEntities.length,
      open: states.filter(state => state.state === "on").length,
      unavailable: room.windowEntities.length - states.length +
        states.filter(state => state.state === "unavailable" || state.state === "unknown").length,
    };
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

    const config = this._config;
    const outside = this._formatTemp(config.outside_temperature);
    const groups = this._sortedGroups();

    const css = `
      :host { display:block; --la-card-radius:18px; --la-gap:12px; }
      ha-card { overflow:hidden; border-radius:var(--ha-card-border-radius,18px); }
      .wrap { padding:16px; }
      .header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; }
      .title { font-size:20px; font-weight:650; color:var(--primary-text-color); line-height:1.2; }
      .outside { color:var(--secondary-text-color); font-size:14px; white-space:nowrap; }
      .outside strong { color:var(--primary-text-color); font-size:16px; }
      .floor { margin-top:16px; }
      .floor:first-child { margin-top:0; }
      .floor-title { color:var(--secondary-text-color); font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; margin:0 0 8px 2px; }
      .grid { display:grid; grid-template-columns:repeat(var(--la-columns),minmax(0,1fr)); gap:var(--la-gap); }
      .room { min-width:0; min-height:145px; padding:14px; box-sizing:border-box; border-radius:var(--la-card-radius); background:var(--ha-card-background,var(--card-background-color)); border:1px solid var(--divider-color); cursor:pointer; transition:transform .12s ease,border-color .12s ease; }
      .room:active { transform:scale(.985); }
      .room:hover { border-color:var(--outline-color,var(--divider-color)); }
      .room-name { font-size:15px; font-weight:600; color:var(--primary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .temp { margin-top:13px; font-size:29px; line-height:1.1; font-weight:650; color:var(--primary-text-color); }
      .temp.useful { color:var(--success-color); }
      .recommendation { margin-top:6px; font-size:13px; color:var(--secondary-text-color); }
      .recommendation.useful { color:var(--success-color); font-weight:600; }
      .windows { margin-top:12px; padding-top:9px; border-top:1px solid var(--divider-color); font-size:13px; color:var(--secondary-text-color); }
      .windows.open { color:var(--warning-color); font-weight:600; }
      .windows.offline,.error { color:var(--error-color); font-weight:600; }
      .message { padding:10px 2px; font-size:14px; line-height:1.45; color:var(--secondary-text-color); }
      @media (max-width:700px) { .wrap{padding:12px}.header{align-items:flex-start}.grid{grid-template-columns:repeat(2,minmax(0,1fr))} }
      @media (max-width:480px) { .header{flex-direction:column;gap:4px}.grid{grid-template-columns:1fr}.room{min-height:135px} }
    `;

    let content = `
      <style>${css}</style>
      <ha-card>
        <div class="wrap">
          <div class="header">
            <div class="title">${this._escape(config.title)}</div>
            ${config.show_outside_temperature
              ? `<div class="outside">Außen <strong>${this._escape(outside)}</strong></div>`
              : ""}
          </div>`;

    if (this._loading && !this._registry) {
      content += `<div class="message">Registry-Daten werden geladen …</div>`;
    } else if (this._loadError) {
      content += `<div class="message error">${this._escape(this._loadError)}</div>`;
    } else if (!groups.length) {
      content += `<div class="message">Keine passenden Räume gefunden.</div>`;
    } else {
      for (const group of groups) {
        content += `<section class="floor">`;
        if (config.show_floor_titles) {
          content += `<div class="floor-title">${this._escape(group.name)}</div>`;
        }

        const columns = Math.max(1, Math.min(6, Number(config.columns) || 3));
        content += `<div class="grid" style="--la-columns:${columns}">`;

        for (const room of group.rooms) {
          const status = this._roomStatus(room);
          const windows = this._windowInfo(room);
          let windowText;
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
              <div class="temp ${status.useful ? "useful" : ""}">${this._escape(this._formatTemp(room.tempEntity))}</div>
              ${config.show_recommendation
                ? `<div class="recommendation ${status.useful ? "useful" : ""}">${this._escape(status.text)}</div>`
                : ""}
              ${config.show_window_count
                ? `<div class="${windowClass}">${this._escape(windowText)}</div>`
                : ""}
            </div>`;
        }

        content += `</div></section>`;
      }
    }

    content += `</div></ha-card>`;
    this.shadowRoot.innerHTML = content;

    this.shadowRoot.querySelectorAll(".room").forEach(element => {
      element.addEventListener("click", () => {
        const entityId = element.dataset.entity;
        if (!entityId) return;
        this.dispatchEvent(new CustomEvent("hass-more-info", {
          bubbles: true,
          composed: true,
          detail: { entityId },
        }));
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
    return new LueftungsassistentCard()._defaultConfig();
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
    this.shadowRoot.innerHTML = `<style>:host{display:block}ha-form{display:block}</style><ha-form></ha-form>`;
    this._form = this.shadowRoot.querySelector("ha-form");
    this._form.hass = this._hass;
    this._form.data = this._config;
    this._form.schema = [
      { name:"outside_temperature", required:true, selector:{ entity:{ domain:["sensor"], device_class:["temperature"] } } },
      { name:"min_delta", selector:{ number:{ min:0, max:20, step:0.5, mode:"box", unit_of_measurement:"°C" } } },
      { name:"columns", selector:{ number:{ min:1, max:6, step:1, mode:"slider" } } },
      { name:"title", selector:{ text:{} } },
      { name:"show_floor_titles", selector:{ boolean:{} } },
      { name:"show_recommendation", selector:{ boolean:{} } },
      { name:"show_window_count", selector:{ boolean:{} } },
      { name:"show_outside_temperature", selector:{ boolean:{} } },
      { name:"floor_order", selector:{ select:{ options:[
        { value:"high_to_low", label:"Höhere Etagen zuerst" },
        { value:"low_to_high", label:"Niedrigere Etagen zuerst" },
      ] } } },
    ];

    this._form.computeLabel = schema => ({
      outside_temperature:"Außentemperatur-Sensor",
      min_delta:"Mindestdifferenz zum Lüften",
      columns:"Spalten",
      title:"Titel",
      show_floor_titles:"Etagen anzeigen",
      show_recommendation:"Lüftungsempfehlung anzeigen",
      show_window_count:"Fensterstatus anzeigen",
      show_outside_temperature:"Außentemperatur anzeigen",
      floor_order:"Reihenfolge der Etagen",
    }[schema.name] || schema.name);

    this._form.addEventListener("value-changed", event => {
      event.stopPropagation();
      this._config = { ...this._config, ...event.detail.value };
      this.dispatchEvent(new CustomEvent("config-changed", {
        bubbles:true,
        composed:true,
        detail:{ config:this._config },
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
if (!window.customCards.some(card => card.type === "lueftungsassistent-card")) {
  window.customCards.push({
    type:"lueftungsassistent-card",
    name:"Lüftungsassistent Card",
    description:"Dynamische Lüftungsübersicht nach Etage und Raum.",
    preview:true,
  });
}

console.info(
  `%c Lueftungsassistent Card %c v${CARD_VERSION} `,
  "color:white;background:#1976d2;font-weight:bold",
  "color:#1976d2;background:white;font-weight:bold"
);
