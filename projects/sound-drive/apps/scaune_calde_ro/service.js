'use strict';

const START_MS = 75000;
const TEMP_MS = 120000;
const SPEED_MS = 5000;
const SIDES = ['driver', 'passenger'];
const CANCELLED = 'Anulat pentru această pornire';
const LABELS = {
    unsupported: 'Traseu BDC neconfirmat',
    already: 'Încălzire deja activă',
    restricted: 'Încălzire limitată de mașină',
    cancelled: 'Activare anulată',
    unconfirmed: 'Comandă neconfirmată',
    accepted: 'Comandă acceptată, stare neconfirmată',
    reported: 'Încălzire raportată activă',
};

const MESSAGES = {
    'Anulat pentru această pornire': ['Canceled for this start', 'Anulat pentru aceasta pornire'],
    'Traseu BDC neconfirmat': ['BDC route unconfirmed', 'Traseu BDC neconfirmat'],
    'Încălzire deja activă': ['Heating already on', 'Incalzire deja activa'],
    'Încălzire limitată de mașină': ['Heating restricted by vehicle', 'Incalzire limitata de masina'],
    'Activare anulată': ['Activation canceled', 'Activare anulata'],
    'Comandă neconfirmată': ['Command unconfirmed', 'Comanda neconfirmata'],
    'Comandă acceptată, stare neconfirmată': ['Command accepted, state unconfirmed', 'Comanda acceptata, stare neconfirmata'],
    'Încălzire raportată activă': ['Vehicle reported heating on', 'Incalzire raportata activa'],
    'Așteaptă o pornire a mașinii': ['Waiting for a vehicle start', 'Asteapta o pornire a masinii'],
    'Starea pornirii nu a putut fi salvată': ['Could not save startup state', 'Starea pornirii nu a putut fi salvata'],
    'Pornire automată dezactivată': ['Automatic startup disabled', 'Pornire automata dezactivata'],
    'Verifică setările de încălzire': ['Check heating settings', 'Verifica setarile de incalzire'],
    'Așteaptă temperatura și viteza': ['Waiting for temperature and speed', 'Asteapta temperatura si viteza'],
    'Fereastra de pornire a expirat': ['Startup window expired', 'Fereastra de pornire a expirat'],
    'Temperatura nu este sub prag': ['Temperature is at or above the threshold', 'Temperatura nu este sub prag'],
    'Verifică modulul scaunelor': ['Checking seat controller', 'Verifica modulul scaunelor'],
    'Modul BDC compatibil nedetectat': ['Compatible BDC controller not detected', 'Modul BDC compatibil nedetectat'],
    'Verifică modulul scaunului': ['Checking seat controller', 'Verifica modulul scaunului'],
    'Verificare încheiată pentru această pornire': ['Checks complete for this start', 'Verificare incheiata pentru aceasta pornire'],
    'Comunicarea cu modulul a eșuat': ['Controller communication failed', 'Comunicarea cu modulul a esuat'],
};

function exteriorTemperature(raw) {
    return Number.isInteger(raw) && raw >= 0 && raw <= 200 ? raw / 2 - 40 : null;
}

function createService(settings, marker, makeBdc, now, checkGapMs) {
    let armed = marker.load(), condition, start = null, busy = false, stopped = false;
    let outdoor = null, tempAt = 0, speed, speedAt = 0;
    let result = 'Așteaptă o pornire a mașinii';
    let seatStatus = {};

    function storeArm(value) {
        try { marker.save(value); armed = value; return true; }
        catch (err) {
            armed = false;
            result = 'Starea pornirii nu a putut fi salvată';
            return false;
        }
    }

    function cancel() {
        if (!start) return;
        start = null;
        result = CANCELLED;
    }

    function observeCondition(next) {
        if (stopped || next === condition) return;
        const wasReady = condition === 10;
        condition = next;
        if (next !== 10) {
            if (wasReady) cancel();
            if (next === 1 || next === 2 || next === 3 || next === 5) storeArm(true);
            return;
        }
        if (!armed) return;
        // Consume the observed OFF → READY cycle before any request. A restart
        // of the app in the same drive cannot send a second activation.
        if (!storeArm(false)) return;
        seatStatus = {};
        if (settings.get('auto') !== true) { result = 'Pornire automată dezactivată'; return; }
        const sides = SIDES.filter((side) => settings.get(side) === true);
        const level = settings.get('level'), threshold = settings.get('threshold');
        if (!sides.length || !Number.isInteger(level) || level < 1 || level > 3 ||
            !Number.isInteger(threshold) || threshold < -5 || threshold > 15) {
            result = 'Verifică setările de încălzire';
            return;
        }
        start = { deadline: now() + START_MS, sides, level, threshold, bdc: null, due: 0 };
        result = 'Așteaptă temperatura și viteza';
    }

    function observeSpeed(raw) {
        speed = Number.isInteger(raw) && raw >= 0 && raw < 65535 ? raw : undefined;
        speedAt = now();
        if (speed > 0) cancel();
    }

    async function tick() {
        const current = start, time = now();
        if (!current || busy || stopped) return;
        if (time > current.deadline) {
            start = null;
            result = 'Fereastra de pornire a expirat';
            return;
        }
        if (time < current.due || speed !== 0 || time - speedAt > SPEED_MS ||
            outdoor === null || time - tempAt > TEMP_MS) return;
        if (outdoor >= current.threshold) {
            start = null;
            result = 'Temperatura nu este sub prag';
            return;
        }
        const allowed = () => !stopped && start === current && condition === 10 &&
            now() <= current.deadline && speed === 0 && now() - speedAt <= SPEED_MS &&
            outdoor !== null && now() - tempAt <= TEMP_MS && outdoor < current.threshold;
        busy = true;
        try {
            if (!current.bdc) {
                result = 'Verifică modulul scaunelor';
                const bdc = await makeBdc();
                if (!allowed()) { if (start === current) cancel(); return; }
                const known = await bdc.identity();
                if (!allowed()) { if (start === current) cancel(); return; }
                if (!known) {
                    start = null;
                    result = 'Modul BDC compatibil nedetectat';
                    return;
                }
                current.bdc = bdc;
            }
            const pending = [];
            for (const side of current.sides) {
                if (!allowed()) { if (start === current) cancel(); return; }
                const state = await current.bdc.check(side, allowed);
                if (state === 'checking') {
                    pending.push(side);
                    seatStatus[side] = 'Verifică modulul scaunului';
                    continue;
                }
                const outcome = state === 'ready' ? await current.bdc.heat(side, current.level, allowed) : state;
                seatStatus[side] = LABELS[outcome];
            }
            if (start !== current) return;
            if (pending.length) {
                current.sides = pending;
                current.due = now() + checkGapMs;
            } else {
                start = null;
                result = 'Verificare încheiată pentru această pornire';
            }
        } catch (err) {
            if (start === current) {
                start = null;
                result = 'Comunicarea cu modulul a eșuat';
            }
        } finally { busy = false; }
    }
    return {
        observeCondition, observeSpeed, tick, cancel,
        needsSpeed() { return !!start && (speed === undefined || now() - speedAt >= 2000); },
        observeTemperature(raw) { outdoor = exteriorTemperature(raw); tempAt = now(); },
        stop() { stopped = true; cancel(); },
        snapshot() { return { outdoor, result, driver: seatStatus.driver, passenger: seatStatus.passenger }; },
    };
}

module.exports = { createService, exteriorTemperature, MESSAGES };
