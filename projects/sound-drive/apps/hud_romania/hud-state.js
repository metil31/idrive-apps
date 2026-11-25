'use strict';

const INDICATOR_MS = 8000;
const ETA_MS = 30000;
const LIMIT = 7 * 86400;
const LEFT = [7, 9, 18, 20, 22];
const RIGHT = [8, 10, 19, 21, 23];
const MANUAL = {
    BLINKEN_AUS: 0,
    TIPP_BLINKEN_LINKS_EIN: 1, TIPP_BLINKEN_RECHTS_EIN: 2,
    DAUER_BLINKEN_LINKS_EIN: 3, DAUER_BLINKEN_RECHTS_EIN: 4,
    BEIDSEITIGES_BLINKEN_EIN: 8,
};
const METRES = { KM: 1000, METER: 1, MILE_US: 1609.344, MILE_UK: 1609.344, FEET: 0.3048, YARD: 0.9144,
    1: 1000, 2: 1609.344, 3: 1609.344, 4: 1, 5: 0.9144, 6: 0.3048 };

function unwrap(v) {
    return v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'value') ? v.value : v;
}
function fresh(now, at, maxAge) {
    const age = now - at;
    return age >= 0 && age < maxAge;
}
function field(v, key) {
    v = unwrap(v);
    if (!v || typeof v !== 'object') return v;
    return Object.prototype.hasOwnProperty.call(v, key) ? unwrap(v[key]) : undefined;
}
function number(v) {
    if (typeof v === 'string' && /^\d+(?:[.,]\d+)?$/.test(v.trim())) v = Number(v.trim().replace(',', '.'));
    return typeof v === 'number' && isFinite(v) && v >= 0 && v < 4294967295 ? v : null;
}
function indicator(v) {
    const raw = field(v, 'controlIndicateDirection');
    const control = typeof raw === 'string' && Object.prototype.hasOwnProperty.call(MANUAL, raw) ? MANUAL[raw] : number(raw);
    const activeRaw = field(v, 'activeFunctionIndicateDirection');
    const numeric = number(activeRaw);
    const active = numeric === null ? activeRaw : numeric;
    if (control === 8 || active === 6 || active === 'WARNBLINKEN_MANUELL') return 'both';
    if (control === 1 || control === 3) return 'left';
    if (control === 2 || control === 4) return 'right';
    if (LEFT.indexOf(active) >= 0 || /^(DAUERBLINKEN|TIPPBLINKEN|FAS_RICHTUNGSBLINKEN_\w+)_LINKS$/.test(String(active))) return 'left';
    if (RIGHT.indexOf(active) >= 0 || /^(DAUERBLINKEN|TIPPBLINKEN|FAS_RICHTUNGSBLINKEN_\w+)_RECHTS$/.test(String(active))) return 'right';
    if (control === 0 || active === 0 || active === 'BLINKEN_AUS') return 'off';
    return null;
}

// Read-only CarPlay DestinationInfo fields, as documented by Aref's MIT ETA Bar.
function decodeWaypoints(v) {
    const route = Array.isArray(v) ? v : field(v, 'waypoints');
    if (!Array.isArray(route) || route.length === 0) return null;
    const final = route.filter((p) => p && p.isCheckeredFlag === true);
    const d = final.length ? final[final.length - 1] : route[route.length - 1];
    if (!d || typeof d !== 'object') return null;
    const stamp = d.estimatedArrivalTime || {}, t = stamp.time || {};
    const h = number(t.hour === undefined ? t.hours : t.hour), m = number(t.minute === undefined ? t.minutes : t.minute);
    const f = d.formattedDistance || {}, raw = number(f.rawDistance), formatted = number(f.distance);
    const unit = f.unit && typeof f.unit === 'object' ? (f.unit.name || f.unit.value) : f.unit;
    const metres = raw !== null ? raw : formatted !== null && METRES[unit] ? formatted * METRES[unit] : null;
    const travel = number(d.travelTime);
    const seconds = travel !== null && travel > 0 && travel < LIMIT ? travel : null;
    const pad = (n) => String(n).padStart(2, '0');
    const arrival = !t.invalid && !(stamp.date && stamp.date.invalid) && Number.isInteger(h) && h < 24 &&
        Number.isInteger(m) && m < 60 ? pad(h) + ':' + pad(m) : null;
    if ((metres === 0 && !seconds) || travel === 0 && metres === null) return null;
    return arrival || seconds || metres > 0 ? { arrival, seconds, metres } : null;
}

function routeLabel(route) {
    const parts = [];
    if (route.arrival) parts.push('Sosire ' + route.arrival);
    if (route.seconds !== null) {
        const minutes = Math.ceil(route.seconds / 60);
        parts.push(minutes < 60 ? minutes + ' min' :
            Math.floor(minutes / 60) + ' h ' + (minutes % 60) + ' min');
    }
    if (route.metres > 0) {
        parts.push(route.metres < 1000 ? Math.round(route.metres) + ' m' :
            (route.metres / 1000).toFixed(route.metres < 10000 ? 1 : 0).replace('.', ',') + ' km');
    }
    return parts.join(' · ');
}

class HudState {
    constructor() {
        this.awake = false;
        this.active = null;
        this.metadata = null;
        this.route = null;
        this.routeAt = 0;
        this.signal = 'off';
        this.signalAt = 0;
        this.blinkAt = 0;
    }

    setReady(ready) {
        if (this.awake && !ready) {
            this.route = null;
            this.signal = 'off';
        }
        this.awake = ready;
    }

    setFlag(key, v) {
        const value = field(v, key);
        if (typeof value !== 'boolean') return;
        if (key === 'projectedGuidanceActive') this.active = value;
        if (key === 'projectedGuidanceMetadataAvailable') this.metadata = value;
        if (!value) this.route = null;
    }

    setWaypoints(v, now) {
        this.route = this.active === false || this.metadata === false ? null : decodeWaypoints(unwrap(v));
        this.routeAt = now;
    }

    setIndicator(v, now) {
        const next = indicator(v);
        if (!next) return;
        if (next !== this.signal || !fresh(now, this.signalAt, INDICATOR_MS)) this.blinkAt = now;
        this.signal = next;
        this.signalAt = now;
    }

    view(now, settings) {
        const direction = this.awake && settings.get('indicators') && fresh(now, this.signalAt, INDICATOR_MS)
            ? this.signal : 'off';
        const bright = ((now - this.blinkAt) % 800) < 400;
        const eta = this.awake && settings.get('eta') && this.active === true && this.metadata !== false &&
            this.route && fresh(now, this.routeAt, ETA_MS) ? routeLabel(this.route) : '';
        return { direction, bright, eta };
    }
}

module.exports = { HudState, decodeWaypoints, routeLabel, field, indicator, INDICATOR_MS, ETA_MS };
