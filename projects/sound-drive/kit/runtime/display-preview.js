'use strict';

const SPEED = 'de.bmw.infotainment.vehicle.Vehicle2';
const FIELD = 'statusCarSpeed2';
const MAX_AGE = 5000;

// The preview is temporary and never uses an unverified standstill.
function displayPreview(signals, log, allowed, changed, now = Date.now) {
    let value = null, until = 0, speedAt = null, subscription, timer, generation = 0;
    const stop = () => {
        const hadValue = value !== null;
        generation++;
        value = null;
        speedAt = null;
        clearInterval(timer);
        if (subscription) { Promise.resolve(subscription.shutdown()).catch(() => {}); subscription = null; }
        if (hadValue) changed();
    };
    const current = () => {
        const at = now();
        return value !== null && allowed() && at < until && speedAt !== null && at - speedAt < MAX_AGE ? value : null;
    };
    function toggle(sample) {
        const same = value === sample;
        stop();
        if (same || !allowed()) return;
        value = sample;
        until = now() + 90000;
        const token = generation, started = now();
        const speed = (data) => {
            if (token !== generation) return;
            let raw = data && data.speedVehicleCentreOfGravity;
            if (raw && typeof raw === 'object') raw = raw.value;
            if (raw !== 0 && raw !== '0') { stop(); return; }
            speedAt = now();
            changed();
        };
        let inFlight = false;
        function poll() {
            if (token !== generation) return;
            const at = now();
            if (!allowed() || at >= until || at - (speedAt === null ? started : speedAt) >= MAX_AGE) { stop(); return; }
            if (inFlight || !subscription || !subscription.proxy) return;
            inFlight = true;
            subscription.proxy.getValue(FIELD, 2000).then(speed).catch(() => {}).then(() => { inFlight = false; });
        }
        signals.watch(SPEED, '1', { [FIELD]: speed }, log).then((sub) => {
            if (token !== generation) { Promise.resolve(sub.shutdown()).catch(() => {}); return; }
            subscription = sub;
            poll();
        }).catch(() => { if (token === generation) stop(); });
        timer = setInterval(poll, 1000);
        if (timer.unref) timer.unref();
        changed();
    }
    return { current, toggle, stop, selected: () => value };
}

module.exports = { displayPreview };
