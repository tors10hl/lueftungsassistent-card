/* Lüftungsassistent Card V2 - Home Assistant Lovelace - v2.0.0 */
const LA_VERSION = "2.0.0";
const LA_CARD = "lueftungsassistent-card-v2";
const LA_EDITOR = "lueftungsassistent-card-v2-editor";

class LueftungsassistentCardV2 extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = this.constructor.defaults();
    this._hass = null;
    this._registry = null;
    this._registryAt = 0;
    this._data = [];
    this._error = null;
    this._loading = false;
    this._pending = false;
    this._timer = null;
  }

  static defaults() {
    return {
      type: `custom:${LA_CARD}`,
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
    if (!config || typeof config !== "object") throw new Error("Ungültige Konfiguration");
    this._config = { ...this.constructor.defaults(), ...config, type: `custom:${LA_CARD}` };
    this._registryAt = 0;
    this._schedule();
  }

  set hass(hass) {
    this._hass = hass;
    this._schedule();
  }
  get hass() { return this._hass; }

  connectedCallback() {
    this._stopTimer();
    this._timer = setInterval(async () => {
      await this._load(true);
      this._render();
    }, 30000);
    this._schedule();
  }

  disconnectedCallback() { this._stopTimer(); }
  _stopTimer() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _schedule() {
    if (this._pending) return;
    this._pending = true;
    queueMicrotask(async () => {
      this._pending = false;
      await this._load(false);
      this._render();
    });
  }

  async _ws(type) { return this._hass.callWS({ type }); }
  _array(value, key) {
    if (Array.isArray(value)) return value;
    return Array.isArray(value?.[key]) ? value[key] : [];
  }

  async _load(force) {
    if (!this._hass?.callWS) {
      this._error = "Home Assistant ist noch nicht verfügbar.";
      return;
    }
    if (!this._config.outside_temperature) {
      this._error = "Kein Außentemperatur-Sensor konfiguriert.";
      this._data = [];
      return;
    }
    if (this._loading) return;
    const now = Date.now();
    if (!force && this._registry && now - this._registryAt < 5000) return;

    this._loading = true;
    this._error = null;
    try {
      const [er, dr, ar, fr, lr] = await Promise.all([
        this._ws("config/entity_registry/list"),
        this._ws("config/device_registry/list"),
        this._ws("config/area_registry/list"),
        this._ws("config/floor_registry/list"),
        this._ws("config/label_registry/list"),
      ]);
      const registry = {
        entities: this._array(er, "entities"),
        devices: this._array(dr, "devices"),
        areas: this._array(ar, "areas"),
        floors: this._array(fr, "floors"),
        labels: this._array(lr, "labels"),
      };
      if (!registry.entities.length) throw new Error("Keine Entitäten aus der Registry erhalten.");
      if (!registry.areas.length) throw new Error("Keine Räume aus der Registry erhalten.");
      if (!registry.labels.length) throw new Error("Keine Labels aus der Registry erhalten.");
      this._registry = registry;
      this._registryAt = now;
      this._data = this._buildRooms();
    } catch (error) {
      console.error(`${LA_CARD}: Registry-Fehler`, error);
      this._error = error?.message || "Registry-Daten konnten nicht geladen werden.";
      this._data = [];
    } finally {
      this._loading = false;
    }
  }

  _normalize(value) {
    return String(value ?? "").trim().toLocaleLowerCase("de-DE")
      .replaceAll("ä", "ae").replaceAll("ö", "oe")
      .replaceAll("ü", "ue").replaceAll("ß", "ss")
      .replace(/[\s-]+/g, "_");
  }

  _buildRooms() {
    const r = this._registry;
    const labelMap = new Map();
    for (const label of r.labels) {
      labelMap.set(this._normalize(label.name), label.label_id);
      labelMap.set(this._normalize(label.label_id), label.label_id);
    }
    const tempLabel = labelMap.get("lueftung_hauptsensor");
    const windowLabel = labelMap.get("fenster");
    const missing = [];
    if (!tempLabel) missing.push("Lueftung_Hauptsensor");
    if (!windowLabel) missing.push("Fenster");
    if (missing.length) {
      this._error = `Label nicht gefunden: ${missing.join(", ")}.`;
      console.warn(`${LA_CARD}: verfügbare Labels`, r.labels);
      return [];
    }

    const areas = new Map(r.areas.map(x => [x.area_id, x]));
    const floors = new Map(r.floors.map(x => [x.floor_id, x]));
    const devices = new Map(r.devices.map(x => [x.id, x]));
    const byArea = new Map();

    for (const entity of r.entities) {
      const device = entity.device_id ? devices.get(entity.device_id) : null;
      const areaId = entity.area_id || device?.area_id;
      if (!areaId || !areas.has(areaId)) continue;
      if (!byArea.has(areaId)) byArea.set(areaId, []);
      byArea.get(areaId).push(entity);
    }

    const rooms = [];
    for (const [areaId, area] of areas) {
      const entities = byArea.get(areaId) || [];
      const hasLabel = (entity, id) => Array.isArray(entity.labels) && entity.labels.includes(id);
      const temperatures = entities.filter(x => hasLabel(x, tempLabel));
      const windows = entities.filter(x => hasLabel(x, windowLabel));
      if (!temperatures.length || !windows.length) continue;
      const floor = area.floor_id ? floors.get(area.floor_id) : null;
      const level = Number(floor?.level);
      rooms.push({
        areaName: area.name || "Unbenannter Raum",
        floorId: area.floor_id || null,
        floorName: floor?.name || "Ohne Etage",
        floorLevel: Number.isFinite(level) ? level : -9999,
        tempEntity: temperatures[0].entity_id,
        windowEntities: windows.map(x => x.entity_id),
      });
    }
    if (!rooms.length) {
      this._error = "Keine passenden Räume gefunden. Hauptsensor und Fenster müssen gelabelt und demselben Raum zugeordnet sein. Die Raumzuordnung darf an der Entität oder am Gerät gesetzt sein.";
    }
    return rooms;
  }

  _groups() {
    const map = new Map();
    for (const room of this._data) {
      const id = room.floorId || "__none__";
      if (!map.has(id)) map.set(id, { id, name: room.floorName, level: room.floorLevel, rooms: [] });
      map.get(id).rooms.push(room);
    }
    for (const group of map.values()) group.rooms.sort((a, b) => a.areaName.localeCompare(b.areaName, "de"));
    const groups = [...map.values()];
    const highFirst = this._config.floor_order !== "low_to_high";
    groups.sort((a, b) => {
      if (a.id === "__none__") return 1;
      if (b.id === "__none__") return -1;
      return highFirst ? b.level - a.level : a.level - b.level;
    });
    return groups;
  }

  _state(id) { return this._hass?.states?.[id]; }
  _number(id) {
    const n = Number(this._state(id)?.state);
    return Number.isFinite(n) ? n : null;
  }
  _temp(id) {
    const state = this._state(id);
    if (!state) return "—";
    const value = Number(state.state);
    if (!Number.isFinite(value)) return state.state;
    const unit = state.attributes?.unit_of_measurement || "°C";
    return `${value.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`;
  }
  _status(room) {
    const inside = this._number(room.tempEntity);
    const outside = this._number(this._config.outside_temperature);
    if (inside == null || outside == null) return { useful: false, text: "Keine Temperaturdaten" };
    const useful = inside - outside >= (Number(this._config.min_delta) || 0);
    return { useful, text: useful ? "↑ Lüften lohnt sich" : "Kein Lüftungsvorteil" };
  }
  _windows(room) {
    let open = 0, offline = 0;
    for (const id of room.windowEntities) {
      const state = this._state(id)?.state;
      if (state === "on" || state === "open") open++;
      else if (!state || state === "unknown" || state === "unavailable") offline++;
    }
    return { total: room.windowEntities.length, open, offline };
  }
  _escape(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  _render() {
    if (!this.shadowRoot) return;
    const c = this._config;
    const groups = this._groups();
    const columns = Math.max(1, Math.min(6, Number(c.columns) || 3));
    let body = "";

    if (this._loading && !this._registry) body = `<div class="message">Registry-Daten werden geladen …</div>`;
    else if (this._error) body = `<div class="message error">${this._escape(this._error)}</div>`;
    else {
      for (const group of groups) {
        body += `<section class="floor">${c.show_floor_titles ? `<div class="floor-title">${this._escape(group.name)}</div>` : ""}<div class="grid" style="--cols:${columns}">`;
        for (const room of group.rooms) {
          const status = this._status(room);
          const windows = this._windows(room);
          let wText = `🔒 alle zu · ${windows.total} Fenster`, wClass = "windows";
          if (windows.offline) { wText = `⚠ ${windows.offline} offline · ${windows.total} Fenster`; wClass += " offline"; }
          else if (windows.open) { wText = `🪟 ${windows.open} offen · ${windows.total} Fenster`; wClass += " open"; }
          body += `<div class="room" data-entity="${this._escape(room.tempEntity)}">
            <div class="room-name">${this._escape(room.areaName)}</div>
            <div class="temp ${status.useful ? "useful" : ""}">${this._escape(this._temp(room.tempEntity))}</div>
            ${c.show_recommendation ? `<div class="recommendation ${status.useful ? "useful" : ""}">${this._escape(status.text)}</div>` : ""}
            ${c.show_window_count ? `<div class="${wClass}">${this._escape(wText)}</div>` : ""}
          </div>`;
        }
        body += `</div></section>`;
      }
    }

    this.shadowRoot.innerHTML = `<style>
      :host{display:block;--gap:12px}ha-card{overflow:hidden;border-radius:var(--ha-card-border-radius,18px)}
      .wrap{padding:16px}.header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
      .title{font-size:20px;font-weight:650;color:var(--primary-text-color)}.outside{font-size:14px;color:var(--secondary-text-color);white-space:nowrap}.outside strong{font-size:16px;color:var(--primary-text-color)}
      .floor{margin-top:16px}.floor:first-of-type{margin-top:0}.floor-title{margin:0 0 8px 2px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--secondary-text-color)}
      .grid{display:grid;grid-template-columns:repeat(var(--cols),minmax(0,1fr));gap:var(--gap)}
      .room{min-width:0;min-height:145px;padding:14px;box-sizing:border-box;border-radius:18px;background:var(--ha-card-background,var(--card-background-color));border:1px solid var(--divider-color);cursor:pointer;transition:transform .12s ease,border-color .12s ease}
      .room:hover{border-color:var(--outline-color,var(--divider-color))}.room:active{transform:scale(.985)}
      .room-name{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--primary-text-color)}
      .temp{margin-top:13px;font-size:29px;line-height:1.1;font-weight:650;color:var(--primary-text-color)}.temp.useful,.recommendation.useful{color:var(--success-color)}
      .recommendation{margin-top:6px;font-size:13px;color:var(--secondary-text-color)}.recommendation.useful{font-weight:600}
      .windows{margin-top:12px;padding-top:9px;border-top:1px solid var(--divider-color);font-size:13px;color:var(--secondary-text-color)}.windows.open{color:var(--warning-color);font-weight:600}.windows.offline,.error{color:var(--error-color);font-weight:600}
      .message{padding:10px 2px;font-size:14px;line-height:1.45;color:var(--secondary-text-color)}
      @media(max-width:700px){.wrap{padding:12px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:480px){.header{flex-direction:column;align-items:flex-start;gap:4px}.grid{grid-template-columns:1fr}.room{min-height:135px}}
    </style><ha-card><div class="wrap"><div class="header"><div class="title">${this._escape(c.title)}</div>
      ${c.show_outside_temperature ? `<div class="outside">Außen <strong>${this._escape(this._temp(c.outside_temperature))}</strong></div>` : ""}
      </div>${body}</div></ha-card>`;

    this.shadowRoot.querySelectorAll(".room").forEach(element => element.addEventListener("click", () => {
      const entityId = element.dataset.entity;
      if (entityId) this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId } }));
    }));
  }

  getCardSize() { return Math.max(3, this._groups().length * 3 + 2); }
  static getConfigElement() { return document.createElement(LA_EDITOR); }
  static getStubConfig() { return this.defaults(); }
}

class LueftungsassistentCardV2Editor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = LueftungsassistentCardV2.defaults();
    this._hass = null;
  }
  setConfig(config) { this._config = { ...LueftungsassistentCardV2.defaults(), ...config }; this._render(); }
  set hass(hass) { this._hass = hass; if (this._form) this._form.hass = hass; }
  _render() {
    this.shadowRoot.innerHTML = `<ha-form></ha-form>`;
    this._form = this.shadowRoot.querySelector("ha-form");
    this._form.hass = this._hass;
    this._form.data = this._config;
    this._form.schema = [
      {name:"outside_temperature",required:true,selector:{entity:{domain:["sensor"],device_class:["temperature"]}}},
      {name:"min_delta",selector:{number:{min:0,max:20,step:.5,mode:"box",unit_of_measurement:"°C"}}},
      {name:"columns",selector:{number:{min:1,max:6,step:1,mode:"slider"}}},
      {name:"title",selector:{text:{}}},{name:"show_floor_titles",selector:{boolean:{}}},
      {name:"show_recommendation",selector:{boolean:{}}},{name:"show_window_count",selector:{boolean:{}}},
      {name:"show_outside_temperature",selector:{boolean:{}}},
      {name:"floor_order",selector:{select:{options:[{value:"high_to_low",label:"Höhere Etagen zuerst"},{value:"low_to_high",label:"Niedrigere Etagen zuerst"}]}}},
    ];
    const labels = {outside_temperature:"Außentemperatur-Sensor",min_delta:"Mindestdifferenz zum Lüften",columns:"Spalten",title:"Titel",show_floor_titles:"Etagen anzeigen",show_recommendation:"Lüftungsempfehlung anzeigen",show_window_count:"Fensterstatus anzeigen",show_outside_temperature:"Außentemperatur anzeigen",floor_order:"Reihenfolge der Etagen"};
    this._form.computeLabel = schema => labels[schema.name] || schema.name;
    this._form.addEventListener("value-changed", event => {
      event.stopPropagation();
      this._config = { ...this._config, ...event.detail.value, type: `custom:${LA_CARD}` };
      this.dispatchEvent(new CustomEvent("config-changed", { bubbles: true, composed: true, detail: { config: this._config } }));
    });
  }
}

if (!customElements.get(LA_CARD)) customElements.define(LA_CARD, LueftungsassistentCardV2);
if (!customElements.get(LA_EDITOR)) customElements.define(LA_EDITOR, LueftungsassistentCardV2Editor);
window.customCards = window.customCards || [];
if (!window.customCards.some(card => card.type === LA_CARD)) window.customCards.push({type:LA_CARD,name:"Lüftungsassistent Card V2",description:"Dynamische Lüftungsübersicht nach Etage und Raum.",preview:true});
console.info(`%c Lüftungsassistent Card V2 %c v${LA_VERSION} `,"color:white;background:#1976d2;font-weight:bold","color:#1976d2;background:white;font-weight:bold");
