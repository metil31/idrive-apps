'use strict';

const SENSORS = [
    { id: 'oil', label: ['OIL', 'ULEI'], demo: 66, min: 60, max: 110, warm: 80 },
    { id: 'coolant', label: ['COOLANT', 'APA'], demo: 72, min: 60, max: 110, warm: 80 },
    { id: 'gearbox', label: ['GEAR OIL', 'CUTIE'], demo: 48, min: 40, max: 100, warm: 60 },
];
const FRESH_MS = 25000;

function decode(raw, offset = -48) {
    if (raw && typeof raw === 'object') raw = raw.value;
    if (!Number.isInteger(raw) || raw < 0 || raw >= 255) return null;
    const celsius = raw + offset;
    return celsius >= -45 && celsius <= 160 ? celsius : null;
}

class Temperatures {
    constructor() { this.reset(); }

    reset() {
        this.samples = new Map();
        this.warmed = new Set();
        this.gearboxStart = null;
        this.gearboxMoves = false;
    }

    observe(id, value, now) {
        if (value === null) this.samples.delete(id);
        else this.samples.set(id, { value, now });
    }

    engine(data, now) {
        this.observe('oil', decode(data && data.temperatureEngineOilDrive), now);
        this.observe('coolant', decode(data && data.temperatureEngineDrive), now);
    }

    gearboxSignal(data, now) {
        const value = decode(data && data.valueTemperatureTransmissionOil);
        if (value === null) { this.samples.delete('gearboxSignal'); return; }
        if (this.gearboxStart === null) this.gearboxStart = value;
        if (Math.abs(value - this.gearboxStart) >= 1) this.gearboxMoves = true;
        if (this.gearboxMoves) this.observe('gearboxSignal', value, now);
    }

    get(id, now) {
        const fresh = key => {
            const sample = this.samples.get(key);
            return sample && now >= sample.now && now - sample.now <= FRESH_MS ? sample.value : null;
        };
        const value = fresh(id);
        return value === null && id === 'gearbox' ? fresh('gearboxSignal') : value;
    }

    visible(settings, now, demo) {
        const output = [];
        for (const sensor of SENSORS) {
            const { id } = sensor;
            if (demo) { output.push({ sensor, value: sensor.demo }); continue; }
            if (!settings.get(id)) continue;
            const value = this.get(id, now);
            if (value === null) continue;
            const threshold = Number(settings.get(id + 'Warm')) || sensor.warm;
            if (value >= threshold) this.warmed.add(id);
            if (settings.get('mode') === 'always' || !this.warmed.has(id)) output.push({ sensor, value });
        }
        return output;
    }
}

module.exports = { Temperatures, SENSORS, decode };
