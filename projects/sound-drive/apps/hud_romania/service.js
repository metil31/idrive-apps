'use strict';

const { HudState, field } = require('./hud-state');
const { HudOutput } = require('./hud-view');

const CONDITION = 'de.bmw.infrastructure.VehicleCondition';
const LIGHT = 'de.bmw.body.Light';
const GUIDANCE = 'de.bmw.infotainment.navigation.projectedmodeguiding.ProjectedModeGuiding';
const PROVIDER = 'de.bmw.infotainment.navigation.guiding.Guidance';
const CARPLAY = 'de.bmw.infotainment.a4a.carplay.CarPlayManager';

function startService(ctx, deps) {
    const { signals, settings, log, app } = ctx;
    const now = deps.now || Date.now;
    const state = new HudState();
    const out = new HudOutput(deps.makeClient, deps.ScaledCanvas);
    let stopped = false, timer;
    const subscriptions = [];
    const retryTimers = new Set();
    const view = () => state.view(now(), settings);
    const tick = () => {
        if (stopped) return;
        const at = now(), live = state.view(at, settings), delay = state.nextUpdate(at, live);
        const sample = deps.preview && deps.preview();
        clearTimeout(timer);
        if (Number.isFinite(delay)) {
            timer = setTimeout(tick, Math.max(1, delay));
            if (timer.unref) timer.unref();
        }
        if (sample === 'indicators') { live.direction = 'both'; live.bright = true; }
        if (sample === 'eta') live.eta = 'Demo · 16:28 · 12 min · 6 km';
        out.update(live, settings);
    };
    const watch = (iface, instance, handlers, attempt = 0) => {
        const retry = (error) => {
            if (stopped || attempt >= 3 || /no SOME\/IP config|native module not available/i.test(String(error))) return;
            const timeout = setTimeout(() => {
                retryTimers.delete(timeout);
                if (!stopped) watch(iface, instance, handlers, attempt + 1);
            }, 5000 * (attempt + 1));
            retryTimers.add(timeout);
            if (timeout.unref) timeout.unref();
        };
        const bound = {};
        Object.keys(handlers).forEach((key) => {
            bound[key] = (v) => { if (!stopped) { handlers[key](v); tick(); } };
        });
        return signals.watch(iface, instance, bound, log).then((sub) => {
            if (stopped) return sub.shutdown();
            if (sub.error && !sub.proxy) { retry(sub.error); return; }
            subscriptions.push(sub);
        }).catch((e) => {
            log.warn('Source unavailable: ' + iface + ': ' + e.message);
            retry(e);
        });
    };
    watch(CONDITION, '1', {
        VehicleCondition: (v) => state.setReady(deps.conditionOf(field(v, 'statusConditionVehicle')) === 10),
    });
    watch(LIGHT, '1', {
        StatusFunctionsIndicators: (v) => state.setIndicator(v, now()),
        StatusFunctionsIndicators2: (v) => state.setIndicator(v, now()),
    });
    const flag = (key) => (v) => state.setFlag(key, v);
    watch(CARPLAY, 'CarPlayManagerInst1', {
        projectedGuidanceActive: flag('projectedGuidanceActive'),
        projectedGuidanceMetadataAvailable: flag('projectedGuidanceMetadataAvailable'),
    });
    watch(GUIDANCE, 'Main_Instance', { waypoints: (v) => state.setWaypoints(v, now()) });
    watch(PROVIDER, 'Main_Instance', { guidingProvider: (v) => state.setProvider(v) });
    settings.onChange(tick);
    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        retryTimers.forEach(clearTimeout);
        retryTimers.clear();
        out.stop();
        subscriptions.forEach((sub) => sub.shutdown().catch(() => {}));
    };
    if (app && typeof app.on === 'function') app.on('shutdown', stop);
    return { state, out, view, etaStatus: t => state.etaStatus(now(), t), tick, stop };
}

module.exports = { startService };
