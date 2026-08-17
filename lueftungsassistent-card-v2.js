/* Lüftungsassistent Card
 * Home Assistant custom Lovelace card
 * v1.3.0
 */

const CARD_VERSION = "1.3.0";

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
    this._forceRegistryReloadPending = false;
    this._loadingPromise = null;
    this._loadGeneration = 0;
    this._loadError = null;
    this._diagnostics = null;
    this._selectedFloorId = "__all__";
  }

  _defaultConfig() {
    return {
      type: "custom:lueftungsassistent-card",
      outside_temperature: "",
      min_delta: 2,
      columns: 3,
      show_floor_selector: true,
      show_floor_titles: true,
      show_recommendation: true,
      show_window_count: true,
      show_outside_temperature: true,
      floor_order: "high_to_low",
      title: "Lüftungsassistent",
      refresh_interval: 30,
      temperature_label: "Lueftung_Hauptsensor",
      window_label: "Fenster",
    };
  }

  setConfig(config) {
    if (!config || typeof config !== "object") {
      throw new Error("Ungültige Kartenkonfiguration");
    }

    this._config = {
      ...this._defaultConfig(),
      ...config,
    };

    this._registryAt = 0;

    if (this.isConnected) {
      this._startRefresh();
    }

    this._scheduleRender(true);
  }

  set hass(hass) {
    const firstAssignment = !this._hass;
    this._hass = hass;

    this._scheduleRender(firstAssignment || !this._registry);
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    this._startRefresh();
    this._scheduleRender(true);
  }

  disconnectedCallback() {
    this._stopRefresh();
    this._loadGeneration += 1;
  }

  _startRefresh() {
    this._stopRefresh();

    const configuredSeconds = Number(
      this._config.refresh_interval
    );

    const seconds = Number.isFinite(configuredSeconds)
      ? Math.max(10, configuredSeconds)
      : 30;

    this._refreshTimer = window.setInterval(() => {
      this._scheduleRender(true);
    }, seconds * 1000);
  }

  _stopRefresh() {
    if (this._refreshTimer !== null) {
      window.clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  _scheduleRender(forceRegistryReload = false) {
    if (forceRegistryReload) {
      this._registryAt = 0;
      this._forceRegistryReloadPending = true;
    }

    if (this._renderPending) {
      return;
    }

    this._renderPending = true;

    queueMicrotask(async () => {
      this._renderPending = false;

      const forceReload =
        this._forceRegistryReloadPending;

      this._forceRegistryReloadPending = false;

      try {
        await this._loadRegistryData(forceReload);
      } catch (error) {
        console.error(
          "lueftungsassistent-card: Unerwarteter Ladefehler",
          error
        );

        this._loadError =
          "Die Home-Assistant-Registrierungsdaten konnten nicht geladen werden.";
      }

      this._render();
    });
  }

  async _ws(type) {
    if (!this._hass?.callWS) {
      throw new Error(
        "Home-Assistant-WebSocket ist nicht verfügbar"
      );
    }

    return this._hass.callWS({ type });
  }

  _unwrapRegistryResult(result, propertyName) {
    if (Array.isArray(result)) {
      return result;
    }

    if (Array.isArray(result?.[propertyName])) {
      return result[propertyName];
    }

    return [];
  }

  async _loadRegistryData(force = false) {
    if (!this._hass?.callWS) {
      return;
    }

    const now = Date.now();

    if (
      !force &&
      this._registry &&
      now - this._registryAt < 5000
    ) {
      return;
    }

    if (this._loadingPromise) {
      return this._loadingPromise;
    }

    const generation = ++this._loadGeneration;

    this._loadingPromise = (async () => {
      this._loadError = null;

      const registryRequests = await Promise.allSettled([
        this._ws("config/entity_registry/list"),
        this._ws("config/device_registry/list"),
        this._ws("config/area_registry/list"),
        this._ws("config/floor_registry/list"),
        this._ws("config/label_registry/list"),
      ]);

      if (generation !== this._loadGeneration) {
        return;
      }

      const registryNames = [
        "entity_registry",
        "device_registry",
        "area_registry",
        "floor_registry",
        "label_registry",
      ];

      const failures = registryRequests
        .map((result, index) => ({
          result,
          name: registryNames[index],
        }))
        .filter(
          item => item.result.status === "rejected"
        );

      for (const failure of failures) {
        console.warn(
          `lueftungsassistent-card: ${failure.name} konnte nicht geladen werden`,
          failure.result.reason
        );
      }

      const getValue = index =>
        registryRequests[index].status === "fulfilled"
          ? registryRequests[index].value
          : null;

      const entities = this._unwrapRegistryResult(
        getValue(0),
        "entities"
      );

      const devices = this._unwrapRegistryResult(
        getValue(1),
        "devices"
      );

      const areas = this._unwrapRegistryResult(
        getValue(2),
        "areas"
      );

      const floors = this._unwrapRegistryResult(
        getValue(3),
        "floors"
      );

      const labels = this._unwrapRegistryResult(
        getValue(4),
        "labels"
      );

      if (
        failures.length > 0 &&
        (!entities.length ||
          !areas.length ||
          !labels.length)
      ) {
        this._loadError =
          "Nicht alle benötigten Home-Assistant-Registries konnten geladen werden.";

        return;
      }

      this._registry = {
        entities,
        devices,
        areas,
        floors,
        labels,
      };

      this._registryAt = Date.now();
      this._data = this._buildRooms();
      this._validateSelectedFloor();
    })();

    try {
      await this._loadingPromise;
    } finally {
      if (generation === this._loadGeneration) {
        this._loadingPromise = null;
      }
    }
  }

  _normalize(value) {
    return String(value ?? "")
      .trim()
      .toLocaleLowerCase("de-DE")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replaceAll("ä", "ae")
      .replaceAll("ö", "oe")
      .replaceAll("ü", "ue")
      .replaceAll("ß", "ss")
      .replace(/[\s-]+/g, "_");
  }

  _asLabelArray(value) {
    if (Array.isArray(value)) {
      return value;
    }

    if (value instanceof Set) {
      return [...value];
    }

    return [];
  }

  _hasLabel(entry, labelId) {
    if (!entry || !labelId) {
      return false;
    }

    return this._asLabelArray(
      entry.labels
    ).includes(labelId);
  }

  _findLabelId(labels, configuredName) {
    const wanted = this._normalize(configuredName);

    for (const label of labels) {
      if (
        this._normalize(label.name) === wanted ||
        this._normalize(label.label_id) === wanted
      ) {
        return label.label_id;
      }
    }

    return null;
  }

  _buildRooms() {
    const registry = this._registry;

    if (!registry) {
      return [];
    }

    const temperatureLabelName =
      this._config.temperature_label ||
      "Lueftung_Hauptsensor";

    const windowLabelName =
      this._config.window_label || "Fenster";

    const temperatureLabelId = this._findLabelId(
      registry.labels,
      temperatureLabelName
    );

    const windowLabelId = this._findLabelId(
      registry.labels,
      windowLabelName
    );

    const availableLabels = registry.labels.map(
      label => ({
        name: label.name,
        label_id: label.label_id,
      })
    );

    if (!temperatureLabelId || !windowLabelId) {
      this._diagnostics = {
        reason: "labels_missing",
        temperatureLabelName,
        windowLabelName,
        temperatureLabelId,
        windowLabelId,
        availableLabels,
      };

      console.warn(
        "lueftungsassistent-card: Benötigte Labels nicht gefunden",
        this._diagnostics
      );

      return [];
    }

    const areasById = new Map(
      registry.areas.map(area => [
        area.area_id,
        area,
      ])
    );

    const floorsById = new Map(
      registry.floors.map(floor => [
        floor.floor_id,
        floor,
      ])
    );

    const devicesById = new Map(
      registry.devices.map(device => [
        device.id,
        device,
      ])
    );

    const entitiesByArea = new Map();

    let entitiesWithoutArea = 0;
    let matchedTemperatureSensors = 0;
    let matchedWindows = 0;

    for (const entity of registry.entities) {
      if (!entity?.entity_id) {
        continue;
      }

      const device = entity.device_id
        ? devicesById.get(entity.device_id)
        : null;

      /*
       * Eine direkt an der Entität gesetzte area_id hat Vorrang.
       * Andernfalls wird der Raum des Geräts verwendet.
       */
      const effectiveAreaId =
        entity.area_id ||
        device?.area_id ||
        null;

      if (!effectiveAreaId) {
        entitiesWithoutArea += 1;
        continue;
      }

      /*
       * Labels direkt an der Entität und Labels am Gerät
       * werden gleichermaßen berücksichtigt.
       */
      const hasTemperatureLabel =
        this._hasLabel(
          entity,
          temperatureLabelId
        ) ||
        this._hasLabel(
          device,
          temperatureLabelId
        );

      const hasWindowLabel =
        this._hasLabel(entity, windowLabelId) ||
        this._hasLabel(device, windowLabelId);

      if (
        !hasTemperatureLabel &&
        !hasWindowLabel
      ) {
        continue;
      }

      if (hasTemperatureLabel) {
        matchedTemperatureSensors += 1;
      }

      if (hasWindowLabel) {
        matchedWindows += 1;
      }

      if (!entitiesByArea.has(effectiveAreaId)) {
        entitiesByArea.set(effectiveAreaId, []);
      }

      entitiesByArea.get(effectiveAreaId).push({
        ...entity,
        _hasTemperatureLabel: hasTemperatureLabel,
        _hasWindowLabel: hasWindowLabel,
      });
    }

    const rooms = [];

    for (const [areaId, area] of areasById) {
      const areaEntities =
        entitiesByArea.get(areaId) || [];

      const temperatureSensors =
        areaEntities.filter(
          entity =>
            entity._hasTemperatureLabel
        );

      const windows = areaEntities.filter(
        entity => entity._hasWindowLabel
      );

      if (
        !temperatureSensors.length ||
        !windows.length
      ) {
        continue;
      }

      /*
       * Verfügbare Temperatursensoren werden bevorzugt.
       */
      temperatureSensors.sort((a, b) => {
        const stateA = this._state(a.entity_id);
        const stateB = this._state(b.entity_id);

        const availableA =
          stateA &&
          stateA.state !== "unknown" &&
          stateA.state !== "unavailable";

        const availableB =
          stateB &&
          stateB.state !== "unknown" &&
          stateB.state !== "unavailable";

        return (
          Number(availableB) -
          Number(availableA)
        );
      });

      const temperatureSensor =
        temperatureSensors[0];

      const floor = area.floor_id
        ? floorsById.get(area.floor_id)
        : null;

      rooms.push({
        areaId,
        areaName:
          area.name || "Unbenannter Raum",
        floorId: area.floor_id || null,
        floorName:
          floor?.name || "Ohne Stockwerk",
        floorLevel: Number.isFinite(
          Number(floor?.level)
        )
          ? Number(floor.level)
          : -9999,
        tempEntity:
          temperatureSensor.entity_id,
        windowEntities: [
          ...new Set(
            windows.map(
              window => window.entity_id
            )
          ),
        ],
      });
    }

    this._diagnostics = {
      reason:
        rooms.length > 0
          ? null
          : "no_complete_rooms",
      temperatureLabelName,
      windowLabelName,
      temperatureLabelId,
      windowLabelId,
      entityCount: registry.entities.length,
      deviceCount: registry.devices.length,
      areaCount: registry.areas.length,
      floorCount: registry.floors.length,
      labelCount: registry.labels.length,
      entitiesWithoutArea,
      matchedTemperatureSensors,
      matchedWindows,
      roomCount: rooms.length,
      availableLabels,
    };

    if (!rooms.length) {
      console.warn(
        "lueftungsassistent-card: Keine vollständigen Räume gefunden",
        this._diagnostics
      );
    }

    return rooms;
  }

  _availableFloors() {
    const floors = new Map();

    for (const room of this._data || []) {
      const id =
        room.floorId || "__no_floor__";

      if (!floors.has(id)) {
        floors.set(id, {
          id,
          name: room.floorName,
          level: room.floorLevel,
        });
      }
    }

    const result = [...floors.values()];
    const highToLow =
      this._config.floor_order !==
      "low_to_high";

    result.sort((a, b) => {
      if (a.id === "__no_floor__") {
        return 1;
      }

      if (b.id === "__no_floor__") {
        return -1;
      }

      if (a.level !== b.level) {
        return highToLow
          ? b.level - a.level
          : a.level - b.level;
      }

      return a.name.localeCompare(
        b.name,
        "de",
        {
          sensitivity: "base",
          numeric: true,
        }
      );
    });

    return result;
  }

  _validateSelectedFloor() {
    const validFloorIds = new Set([
      "__all__",
      ...this._availableFloors().map(
        floor => floor.id
      ),
    ]);

    if (
      !validFloorIds.has(
        this._selectedFloorId
      )
    ) {
      this._selectedFloorId = "__all__";
    }
  }

  _sortedGroups() {
    const rooms = this._data || [];
    const groups = new Map();

    for (const room of rooms) {
      const key =
        room.floorId || "__no_floor__";

      if (
        this._selectedFloorId !==
          "__all__" &&
        key !== this._selectedFloorId
      ) {
        continue;
      }

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
      group.rooms.sort((a, b) =>
        a.areaName.localeCompare(
          b.areaName,
          "de",
          {
            sensitivity: "base",
            numeric: true,
          }
        )
      );
    }

    const groupsArray = [
      ...groups.values(),
    ];

    const highToLow =
      this._config.floor_order !==
      "low_to_high";

    groupsArray.sort((a, b) => {
      if (a.id === "__no_floor__") {
        return 1;
      }

      if (b.id === "__no_floor__") {
        return -1;
      }

      if (a.level !== b.level) {
        return highToLow
          ? b.level - a.level
          : a.level - b.level;
      }

      return a.name.localeCompare(
        b.name,
        "de",
        {
          sensitivity: "base",
          numeric: true,
        }
      );
    });

    return groupsArray;
  }

  _state(entityId) {
    if (!entityId) {
      return null;
    }

    return (
      this._hass?.states?.[entityId] ||
      null
    );
  }

  _isUnavailableState(state) {
    return (
      !state ||
      state.state === "unavailable" ||
      state.state === "unknown"
    );
  }

  _numeric(entityId) {
    const state = this._state(entityId);

    if (this._isUnavailableState(state)) {
      return null;
    }

    const numericValue = Number(
      state.state
    );

    return Number.isFinite(numericValue)
      ? numericValue
      : null;
  }

  _formatTemp(entityId) {
    const state = this._state(entityId);

    if (!state) {
      return "—";
    }

    if (state.state === "unavailable") {
      return "Nicht verfügbar";
    }

    if (state.state === "unknown") {
      return "Unbekannt";
    }

    const numericValue = Number(
      state.state
    );

    if (!Number.isFinite(numericValue)) {
      return state.state || "—";
    }

    const unit =
      state.attributes
        ?.unit_of_measurement || "°C";

    return `${numericValue.toLocaleString(
      "de-DE",
      {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }
    )} ${unit}`;
  }

  _roomStatus(room) {
    const inside = this._numeric(
      room.tempEntity
    );

    const outside = this._numeric(
      this._config.outside_temperature
    );

    const configuredDelta = Number(
      this._config.min_delta
    );

    const delta = Number.isFinite(
      configuredDelta
    )
      ? configuredDelta
      : 2;

    if (inside === null) {
      return {
        useful: false,
        unknown: true,
        text: "Innentemperatur fehlt",
      };
    }

    if (outside === null) {
      return {
        useful: false,
        unknown: true,
        text: "Außentemperatur fehlt",
      };
    }

    const difference = inside - outside;
    const useful = difference >= delta;

    return {
      useful,
      unknown: false,
      difference,
      text: useful
        ? `↑ Lüften lohnt sich (${this._formatDifference(
            difference
          )})`
        : `Kein Lüftungsvorteil (${this._formatDifference(
            difference
          )})`,
    };
  }

  _formatDifference(value) {
    if (!Number.isFinite(value)) {
      return "—";
    }

    const prefix = value > 0 ? "+" : "";

    return `${prefix}${value.toLocaleString(
      "de-DE",
      {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }
    )} °C`;
  }

  _isWindowOpen(state) {
    if (!state) {
      return false;
    }

    return [
      "on",
      "open",
      "opened",
      "true",
      "1",
    ].includes(
      String(state.state).toLowerCase()
    );
  }

  _windowInfo(room) {
    const entries =
      room.windowEntities.map(entityId => ({
        entityId,
        state: this._state(entityId),
      }));

    const unavailable = entries.filter(
      entry =>
        this._isUnavailableState(
          entry.state
        )
    ).length;

    const availableEntries =
      entries.filter(
        entry =>
          !this._isUnavailableState(
            entry.state
          )
      );

    const open = availableEntries.filter(
      entry =>
        this._isWindowOpen(entry.state)
    ).length;

    return {
      configuredTotal: entries.length,
      availableTotal:
        availableEntries.length,
      unavailable,
      open,
      closed: Math.max(
        0,
        availableEntries.length - open
      ),
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

  _emptyMessage() {
    if (this._loadError) {
      return this._loadError;
    }

    if (!this._registry) {
      return (
        "Registrierungsdaten werden geladen …"
      );
    }

    if (
      this._diagnostics?.reason ===
      "labels_missing"
    ) {
      const missingLabels = [];

      if (
        !this._diagnostics
          .temperatureLabelId
      ) {
        missingLabels.push(
          `„${this._diagnostics.temperatureLabelName}“`
        );
      }

      if (
        !this._diagnostics.windowLabelId
      ) {
        missingLabels.push(
          `„${this._diagnostics.windowLabelName}“`
        );
      }

      return (
        "Folgende Labels wurden nicht gefunden: " +
        `${missingLabels.join(" und ")}.`
      );
    }

    if (
      this._diagnostics?.reason ===
      "no_complete_rooms"
    ) {
      const temperatureCount =
        this._diagnostics
          .matchedTemperatureSensors || 0;

      const windowCount =
        this._diagnostics
          .matchedWindows || 0;

      return (
        "Keine vollständigen Räume gefunden. " +
        `Erkannte Hauptsensoren: ${temperatureCount}, ` +
        `erkannte Fenster: ${windowCount}. ` +
        "Jeder Raum benötigt mindestens einen Hauptsensor " +
        "und einen Fensterkontakt."
      );
    }

    return "Keine Räume gefunden.";
  }

  _fireMoreInfo(entityId) {
    if (!entityId) {
      return;
    }

    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        bubbles: true,
        composed: true,
        detail: {
          entityId,
        },
      })
    );
  }

  _render() {
    if (!this.shadowRoot) {
      return;
    }

    this._validateSelectedFloor();

    const config = this._config;

    const outsideTemperature =
      this._formatTemp(
        config.outside_temperature
      );

    const availableFloors =
      this._availableFloors();

    const groups = this._sortedGroups();

    const configuredColumns = Number(
      config.columns
    );

    const columns = Number.isFinite(
      configuredColumns
    )
      ? Math.max(
          1,
          Math.min(
            6,
            Math.round(configuredColumns)
          )
        )
      : 3;

    const floorOptions = [
      `
        <option
          value="__all__"
          ${
            this._selectedFloorId ===
            "__all__"
              ? "selected"
              : ""
          }
        >
          Alle Stockwerke
        </option>
      `,
      ...availableFloors.map(
        floor => `
          <option
            value="${this._escape(floor.id)}"
            ${
              this._selectedFloorId ===
              floor.id
                ? "selected"
                : ""
            }
          >
            ${this._escape(floor.name)}
          </option>
        `
      ),
    ].join("");

    const css = `
      :host {
        display: block;
        --la-card-radius: 18px;
        --la-gap: 12px;
      }

      ha-card {
        overflow: hidden;
        border-radius:
          var(--ha-card-border-radius, 18px);
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
        min-width: 0;
        overflow: hidden;
        color: var(--primary-text-color);
        font-size: 20px;
        font-weight: 650;
        line-height: 1.2;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .header-controls {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: flex-end;
        gap: 12px;
      }

      .floor-selector {
        min-width: 160px;
        height: 38px;
        padding: 0 34px 0 12px;
        box-sizing: border-box;
        border: 1px solid
          var(--divider-color);
        border-radius: 10px;
        outline: none;
        background:
          var(
            --ha-card-background,
            var(--card-background-color)
          );
        color: var(--primary-text-color);
        font: inherit;
        font-size: 14px;
        cursor: pointer;
      }

      .floor-selector:hover {
        border-color:
          var(
            --outline-color,
            var(--primary-color)
          );
      }

      .floor-selector:focus-visible {
        border-color:
          var(--primary-color);
        box-shadow:
          0 0 0 2px
          color-mix(
            in srgb,
            var(--primary-color) 30%,
            transparent
          );
      }

      .outside {
        flex: 0 0 auto;
        color:
          var(--secondary-text-color);
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
        margin: 0 0 8px 2px;
        color:
          var(--secondary-text-color);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .grid {
        display: grid;
        grid-template-columns:
          repeat(
            var(--la-columns),
            minmax(0, 1fr)
          );
        gap: var(--la-gap);
      }

      .room {
        min-width: 0;
        min-height: 145px;
        padding: 14px;
        box-sizing: border-box;
        overflow: hidden;
        border: 1px solid
          var(--divider-color);
        border-radius:
          var(--la-card-radius);
        background:
          var(
            --ha-card-background,
            var(--card-background-color)
          );
        cursor: pointer;
        outline: none;
        transition:
          transform 0.12s ease,
          border-color 0.12s ease,
          box-shadow 0.12s ease;
      }

      .room:hover {
        border-color:
          var(
            --outline-color,
            var(--divider-color)
          );
      }

      .room:focus-visible {
        border-color:
          var(--primary-color);
        box-shadow:
          0 0 0 2px
          var(--primary-color);
      }

      .room:active {
        transform: scale(0.985);
      }

      .room-name {
        overflow: hidden;
        color: var(--primary-text-color);
        font-size: 15px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .temp {
        margin-top: 13px;
        overflow: hidden;
        color: var(--primary-text-color);
        font-size: 29px;
        font-weight: 650;
        line-height: 1.1;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .temp.useful {
        color: var(--success-color);
      }

      .temp.unknown {
        color:
          var(--secondary-text-color);
        font-size: 20px;
      }

      .recommendation {
        min-height: 18px;
        margin-top: 6px;
        color:
          var(--secondary-text-color);
        font-size: 13px;
        line-height: 1.35;
      }

      .recommendation.useful {
        color: var(--success-color);
        font-weight: 600;
      }

      .recommendation.unknown {
        color: var(--error-color);
      }

      .windows {
        margin-top: 12px;
        padding-top: 9px;
        border-top: 1px solid
          var(--divider-color);
        color:
          var(--secondary-text-color);
        font-size: 13px;
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
        padding: 10px 2px;
        color:
          var(--secondary-text-color);
        font-size: 14px;
        line-height: 1.5;
      }

      @media (max-width: 700px) {
        .wrap {
          padding: 12px;
        }

        .header {
          align-items: flex-start;
          flex-direction: column;
        }

        .header-controls {
          width: 100%;
          justify-content: space-between;
        }

        .floor-selector {
          min-width: 0;
          max-width: 220px;
        }

        .grid {
          grid-template-columns:
            repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 480px) {
        .header {
          gap: 8px;
        }

        .title {
          width: 100%;
        }

        .header-controls {
          align-items: stretch;
          flex-direction: column;
          gap: 8px;
        }

        .floor-selector {
          width: 100%;
          max-width: none;
        }

        .grid {
          grid-template-columns: 1fr;
        }

        .room {
          min-height: 135px;
        }
      }

      @media (
        prefers-reduced-motion: reduce
      ) {
        .room {
          transition: none;
        }
      }
    `;

    let content = `
      <style>${css}</style>

      <ha-card>
        <div class="wrap">
          <div class="header">
            <div class="title">
              ${this._escape(config.title)}
            </div>

            <div class="header-controls">
              ${
                config.show_floor_selector &&
                availableFloors.length > 1
                  ? `
                    <select
                      id="floor-selector"
                      class="floor-selector"
                      aria-label="Stockwerk auswählen"
                    >
                      ${floorOptions}
                    </select>
                  `
                  : ""
              }

              ${
                config.show_outside_temperature
                  ? `
                    <div class="outside">
                      Außen
                      <strong>
                        ${this._escape(
                          outsideTemperature
                        )}
                      </strong>
                    </div>
                  `
                  : ""
              }
            </div>
          </div>
    `;

    if (!groups.length) {
      content += `
        <div class="empty">
          ${this._escape(
            this._emptyMessage()
          )}
        </div>
      `;
    } else {
      for (const group of groups) {
        content += `
          <section class="floor">
        `;

        if (config.show_floor_titles) {
          content += `
            <div class="floor-title">
              ${this._escape(group.name)}
            </div>
          `;
        }

        content += `
          <div
            class="grid"
            style="--la-columns:${columns}"
          >
        `;

        for (const room of group.rooms) {
          const status =
            this._roomStatus(room);

          const windows =
            this._windowInfo(room);

          let windowText;
          let windowClass = "windows";

          if (windows.unavailable > 0) {
            windowClass += " offline";

            windowText =
              `⚠ ${windows.unavailable} nicht verfügbar · ` +
              `${windows.configuredTotal} Fenster`;
          } else if (windows.open > 0) {
            windowClass += " open";

            windowText =
              `🪟 ${windows.open} offen · ` +
              `${windows.configuredTotal} Fenster`;
          } else {
            windowText =
              "🔒 alle geschlossen · " +
              `${windows.configuredTotal} Fenster`;
          }

          const tempClasses = [
            "temp",
            status.useful ? "useful" : "",
            status.unknown ? "unknown" : "",
          ]
            .filter(Boolean)
            .join(" ");

          const recommendationClasses = [
            "recommendation",
            status.useful ? "useful" : "",
            status.unknown ? "unknown" : "",
          ]
            .filter(Boolean)
            .join(" ");

          content += `
            <div
              class="room"
              data-entity="${this._escape(
                room.tempEntity
              )}"
              role="button"
              tabindex="0"
              aria-label="${this._escape(
                `${room.areaName}, ${this._formatTemp(
                  room.tempEntity
                )}`
              )}"
            >
              <div class="room-name">
                ${this._escape(
                  room.areaName
                )}
              </div>

              <div class="${tempClasses}">
                ${this._escape(
                  this._formatTemp(
                    room.tempEntity
                  )
                )}
              </div>

              ${
                config.show_recommendation
                  ? `
                    <div
                      class="${recommendationClasses}"
                    >
                      ${this._escape(
                        status.text
                      )}
                    </div>
                  `
                  : ""
              }

              ${
                config.show_window_count
                  ? `
                    <div class="${windowClass}">
                      ${this._escape(
                        windowText
                      )}
                    </div>
                  `
                  : ""
              }
            </div>
          `;
        }

        content += `
            </div>
          </section>
        `;
      }
    }

    content += `
        </div>
      </ha-card>
    `;

    this.shadowRoot.innerHTML = content;

    const floorSelector =
      this.shadowRoot.querySelector(
        "#floor-selector"
      );

    if (floorSelector) {
      floorSelector.value =
        this._selectedFloorId;

      floorSelector.addEventListener(
        "change",
        event => {
          this._selectedFloorId =
            event.currentTarget.value ||
            "__all__";

          this._render();
        }
      );
    }

    this.shadowRoot
      .querySelectorAll(".room")
      .forEach(element => {
        const openMoreInfo = () => {
          this._fireMoreInfo(
            element.dataset.entity
          );
        };

        element.addEventListener(
          "click",
          openMoreInfo
        );

        element.addEventListener(
          "keydown",
          event => {
            if (
              event.key === "Enter" ||
              event.key === " "
            ) {
              event.preventDefault();
              openMoreInfo();
            }
          }
        );
      });
  }

  getCardSize() {
    const visibleRooms =
      this._sortedGroups().reduce(
        (total, group) =>
          total + group.rooms.length,
        0
      );

    const columns = Math.max(
      1,
      Math.min(
        6,
        Number(this._config.columns) || 3
      )
    );

    return Math.max(
      3,
      Math.ceil(visibleRooms / columns) *
        3 +
        2
    );
  }

  static getConfigElement() {
    return document.createElement(
      "lueftungsassistent-card-editor"
    );
  }

  static getStubConfig() {
    return {
      type:
        "custom:lueftungsassistent-card",
      outside_temperature: "",
      min_delta: 2,
      columns: 3,
      show_floor_selector: true,
      show_floor_titles: true,
      show_recommendation: true,
      show_window_count: true,
      show_outside_temperature: true,
      floor_order: "high_to_low",
      title: "Lüftungsassistent",
      refresh_interval: 30,
      temperature_label:
        "Lueftung_Hauptsensor",
      window_label: "Fenster",
    };
  }
}

class LueftungsassistentCardEditor extends HTMLElement {
  constructor() {
    super();

    this.attachShadow({ mode: "open" });

    this._config = {
      ...LueftungsassistentCard.getStubConfig(),
    };

    this._hass = null;
    this._form = null;

    this._valueChangedHandler = event =>
      this._handleValueChanged(event);
  }

  setConfig(config) {
    this._config = {
      ...LueftungsassistentCard.getStubConfig(),
      ...config,
    };

    this._render();
  }

  set hass(hass) {
    this._hass = hass;

    if (this._form) {
      this._form.hass = hass;
    }
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    if (!this._form) {
      this._render();
    }
  }

  _schema() {
    return [
      {
        name: "outside_temperature",
        required: true,
        selector: {
          entity: {
            domain: ["sensor"],
            device_class: [
              "temperature",
            ],
          },
        },
      },
      {
        name: "temperature_label",
        required: true,
        selector: {
          text: {},
        },
      },
      {
        name: "window_label",
        required: true,
        selector: {
          text: {},
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
        name: "refresh_interval",
        selector: {
          number: {
            min: 10,
            max: 600,
            step: 10,
            mode: "box",
            unit_of_measurement: "s",
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
        name: "show_floor_selector",
        selector: {
          boolean: {},
        },
      },
      {
        name: "show_floor_titles",
        selector: {
          boolean: {},
        },
      },
      {
        name: "show_recommendation",
        selector: {
          boolean: {},
        },
      },
      {
        name: "show_window_count",
        selector: {
          boolean: {},
        },
      },
      {
        name:
          "show_outside_temperature",
        selector: {
          boolean: {},
        },
      },
      {
        name: "floor_order",
        selector: {
          select: {
            options: [
              {
                value: "high_to_low",
                label:
                  "Höhere Stockwerke zuerst",
              },
              {
                value: "low_to_high",
                label:
                  "Niedrigere Stockwerke zuerst",
              },
            ],
          },
        },
      },
    ];
  }

  _computeLabel(schema) {
    const labels = {
      outside_temperature:
        "Außentemperatur-Sensor",
      temperature_label:
        "Label des Hauptsensors",
      window_label:
        "Label der Fensterkontakte",
      min_delta:
        "Mindestdifferenz zum Lüften",
      columns: "Spalten",
      refresh_interval:
        "Registry-Aktualisierung",
      title: "Titel",
      show_floor_selector:
        "Stockwerksauswahl anzeigen",
      show_floor_titles:
        "Stockwerktitel anzeigen",
      show_recommendation:
        "Lüftungsempfehlung anzeigen",
      show_window_count:
        "Fensterstatus anzeigen",
      show_outside_temperature:
        "Außentemperatur anzeigen",
      floor_order:
        "Reihenfolge der Stockwerke",
    };

    return (
      labels[schema.name] || schema.name
    );
  }

  _handleValueChanged(event) {
    event.stopPropagation();

    if (!event.detail?.value) {
      return;
    }

    this._config = {
      ...this._config,
      ...event.detail.value,
    };

    this.dispatchEvent(
      new CustomEvent("config-changed", {
        bubbles: true,
        composed: true,
        detail: {
          config: this._config,
        },
      })
    );
  }

  _render() {
    if (!this.shadowRoot) {
      return;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }

        ha-form {
          display: block;
        }
      </style>

      <ha-form></ha-form>
    `;

    this._form =
      this.shadowRoot.querySelector(
        "ha-form"
      );

    this._form.hass = this._hass;
    this._form.data = this._config;
    this._form.schema = this._schema();

    this._form.computeLabel = schema =>
      this._computeLabel(schema);

    this._form.addEventListener(
      "value-changed",
      this._valueChangedHandler
    );
  }
}

if (
  !customElements.get(
    "lueftungsassistent-card"
  )
) {
  customElements.define(
    "lueftungsassistent-card",
    LueftungsassistentCard
  );
}

if (
  !customElements.get(
    "lueftungsassistent-card-editor"
  )
) {
  customElements.define(
    "lueftungsassistent-card-editor",
    LueftungsassistentCardEditor
  );
}

window.customCards =
  window.customCards || [];

if (
  !window.customCards.some(
    card =>
      card.type ===
      "lueftungsassistent-card"
  )
) {
  window.customCards.push({
    type: "lueftungsassistent-card",
    name: "Lüftungsassistent Card",
    description:
      "Dynamische Lüftungsübersicht nach Stockwerk und Raum.",
    preview: true,
  });
}

console.info(
  `%c Lüftungsassistent Card %c v${CARD_VERSION} `,
  "color:white;background:#1976d2;font-weight:bold",
  "color:#1976d2;background:white;font-weight:bold"
);
