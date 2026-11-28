'use strict';

const mgu = require('./kit/mgu');
const { conditionOf } = require('./kit/car');
const { ScaledCanvas } = require('./kit/canvas');
const { displayPreview } = require('./kit/display-preview');
const { menuLanguage } = require('./kit/menu-language');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { watchRetry } = require('./kit/watch-retry');
const { ClusterRender } = require('./cluster_render_client');
const { Temperatures, SENSORS, decode } = require('./temperature');

const CONDITION = 'de.bmw.infrastructure.VehicleCondition';
const CDS = 'de.bmw.infotainment.vehicle.CDS';
const BASIC = 'de.bmw.infrastructure.analytics.BasicDataSet';
const TARGETS = {
    hud: { w: 800, h: 480, tx: 400, ty: 180, key: 'hud' },
    panel: { w: 1920, h: 720, tx: 960, ty: 610, key: 'cluster' },
};
const W = 292, H = 56, SCALE = 2;
const SIZES = [70, 80, 90, 100, 110, 120, 130];

function place(settings, target) {
    const { w, h, tx, ty, key } = target;
    const scale = (SIZES[settings.get(key + 'Size')] || 100) / 100;
    const width = Math.round(W * scale), height = Math.round(H * scale);
    const clamp = (value, max) => Math.max(0, Math.min(max, Math.round(value)));
    const x = clamp(tx + Number(settings.get(key + 'X') || 0) - width / 2, w - width);
    const y = clamp(ty + Number(settings.get(key + 'Y') || 0) - height / 2, h - height);
    return { x, y, w: width, h: height };
}

function renderCard(readings, romanian) {
    const cv = new ScaledCanvas(W, H, SCALE).clear();
    const style = { align: 'center', font: 'bold', literal: true };
    readings.forEach(({ sensor, value }, index) => {
        const x = W / 2 + (index - (readings.length - 1) / 2) * 94;
        cv.text(sensor.label[romanian ? 1 : 0], x, 14, 11, '#e1edf8', style);
        const text = Math.round(value) + '°';
        cv.text(text, x, 45, 28, '#102136', style);
        cv.text(text, x, 43, 28, '#68caff', style);
    });
    const pixels = cv.canvas.d;
    return Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}

function background({ app, settings, signals, log }) {
    const readings = new Temperatures(), layers = new Map();
    let ready = false, stopped = false, cycle = 0, client, connected = false, link, ticking, pollAt = 0;
    let egsUnsupported = false, egsPending = false;
    const preview = displayPreview(signals, log, () => ready && !stopped, draw);
    const active = () => ready && (settings.get('hud') || settings.get('cluster'));

    function close() {
        const current = client;
        client = null; connected = false; layers.clear();
        if (current) current.close();
    }

    function draw() {
        if (stopped) return;
        const sample = preview.current();
        const values = active() || sample ? readings.visible(settings, Date.now(), !!sample) : [];
        if (!values.length) { close(); return; }
        if (!client) {
            const current = client = new ClusterRender('drive_temps');
            current.on('ready', () => { if (client === current) { connected = true; draw(); } });
            current.on('disconnected', () => { if (client === current) connected = false; });
            current.connect();
        }
        if (!connected) return;
        const romanian = settings.get('menuLanguage') === 'ro';
        const key = JSON.stringify([romanian, values.map(item => [item.sensor.id, Math.round(item.value)])]);
        let pixels;
        for (const [surface, target] of Object.entries(TARGETS)) {
            let layer = layers.get(surface);
            const offered = client.targets.split(',').includes(surface + ':' + target.w + 'x' + target.h);
            if (!offered || !(sample ? sample === surface : settings.get(target.key))) {
                if (layer) { client.drop(layer.ref); layers.delete(surface); }
                continue;
            }
            const rect = place(settings, target), at = JSON.stringify(rect);
            if (!layer) {
                const ref = client.image(Object.assign({ target: surface, klass: 'overlay', z: 14,
                    iw: W * SCALE, ih: H * SCALE, sampling: 'bilinear', fps: 2, contend: 0, yield: 1 }, rect));
                if (!ref) continue;
                layer = { ref, at };
                layers.set(surface, layer);
            } else if (layer.at !== at) {
                client.set(layer.ref, rect);
                layer.at = at;
            }
            if (key !== layer.key) {
                if (!pixels) pixels = renderCard(values, romanian);
                if (client.pixels(layer.ref, null, pixels)) layer.key = key;
            }
        }
    }

    async function readGearbox(now) {
        if (egsPending || egsUnsupported || now < pollAt || !settings.get('gearbox') ||
            readings.get('gearboxSignal', now) !== null ||
            settings.get('mode') !== 'always' && readings.warmed.has('gearbox')) return;
        const generation = cycle;
        egsPending = true;
        pollAt = now + 30000;
        try {
            if (!link) {
                link = await new ReadOnlyDiag(signals, log).init();
                if (!link.ready) { link = null; return; }
            }
            if (!active() || stopped || generation !== cycle) return;
            link.wake(0x18);
            const reply = await link.read(0x18, 0x6000, 1500);
            if (!active() || stopped || generation !== cycle) return;
            if (reply && reply[0] === 0x7F && reply[1] === 0x22 && [0x11, 0x12, 0x31].includes(reply[2])) {
                egsUnsupported = true;
            } else if (reply && reply[0] === 0x62 && reply[1] === 0x60 && reply[2] === 0x00 && reply.length >= 4) {
                const value = decode(reply[3], -40);
                if (value !== null) {
                    readings.observe('gearbox', value, Date.now());
                    pollAt = Date.now() + 8000;
                    draw();
                }
            }
        } catch (error) {
            if (log) log.warn('Gearbox temperature: ' + error.message);
        } finally { egsPending = false; }
    }

    function tick() {
        if (stopped) return;
        if (active() && !ticking) {
            ticking = setInterval(tick, 2000);
            if (ticking.unref) ticking.unref();
        } else if (!active() && ticking) {
            clearInterval(ticking); ticking = null;
            if (link) link.cancel();
        }
        if (active()) readGearbox(Date.now());
        draw();
    }

    const watches = [];
    watches.push(
        watchRetry(signals, CONDITION, '1', { VehicleCondition: value => {
            const next = conditionOf(value && value.statusConditionVehicle) === 10;
            if (next === ready) return;
            ready = next; cycle++; readings.reset(); pollAt = Date.now() + 5000;
            if (!ready) preview.stop();
            else { if (watches[1]) watches[1].refresh(); if (watches[2]) watches[2].refresh(); }
            tick();
        } }, log, { pollMs: 10000 }),
        watchRetry(signals, CDS, '1', { statusEngineTemperature: value => {
            if (ready) { readings.engine(value, Date.now()); draw(); }
        } }, log, { pollMs: 5000, poll: active }),
        watchRetry(signals, BASIC, '1', { basicDataSet: value => {
            if (ready) { readings.gearboxSignal(value, Date.now()); draw(); }
        } }, log),
    );
    settings.onChange(key => {
        if (typeof key === 'string' && key.endsWith('Warm')) readings.warmed.delete(key.slice(0, -4));
        tick();
    });
    app.on('shutdown', () => {
        stopped = true;
        clearInterval(ticking);
        if (link) link.cancel();
        preview.stop();
        close();
        watches.forEach(watch => watch.stop());
    });
    return { preview, snapshot: () => ({ ready, live: readings.visible(settings, Date.now(), false).length,
        readings: SENSORS.map(sensor => readings.get(sensor.id, Date.now())) }) };
}

function start(ctx) {
    const { ui, app, settings, background: service } = ctx;
    const { t, render: renderLanguage } = menuLanguage(ctx);
    const changes = new Map();
    function write(key, value, apply) { if (changes.get(key) !== value) { changes.set(key, value); apply(value); } }
    const select = (id, key, values) => ui.onClick(id, ({ row }) => {
        if (values[row] !== undefined) settings.set(key, values[row]);
    });
    const toggle = (id, key) => ui.onClick(id, () => settings.set(key, !settings.get(key)));
    const slider = (id, key, toSetting) => {
        const control = ui.comp(id);
        if (control && control.on) control.on('changed', step => {
            if (Number.isInteger(step)) settings.set(key, toSetting(step));
        });
    };
    select('DT_MODE', 'mode', ['warm', 'always']);
    for (const [index, sensor] of SENSORS.entries()) {
        toggle('DT_SENSOR' + index, sensor.id);
        slider('DT_WARM' + index, sensor.id + 'Warm',
            step => Math.min(sensor.max, Math.max(sensor.min, sensor.min + 5 * step)));
    }
    for (const [surface, target] of Object.entries(TARGETS)) {
        const prefix = 'DT_' + surface.toUpperCase(), key = target.key;
        toggle(prefix + '_ON', key);
        slider(prefix + '_SIZE', key + 'Size', step => Math.max(0, Math.min(6, step)));
        for (const [dir, axis, step] of [['LEFT', 'X', -10], ['RIGHT', 'X', 10], ['UP', 'Y', -10], ['DOWN', 'Y', 10]]) {
            ui.onClick(prefix + '_' + dir, () => {
                const keyAxis = key + axis, extent = axis === 'X' ? target.w : target.h;
                const centre = axis === 'X' ? target.tx : target.ty, rect = place(settings, target);
                const half = (axis === 'X' ? rect.w : rect.h) / 2;
                const value = Math.max(Math.ceil(half - centre), Math.min(Math.floor(extent - centre - half),
                    Number(settings.get(keyAxis) || 0) + step));
                if (value !== settings.get(keyAxis)) settings.set(keyAxis, value);
            });
        }
        ui.onClick(prefix + '_RESET', () => { settings.set(key + 'X', 0); settings.set(key + 'Y', 0); });
        if (service) ui.onClick(prefix + '_DEMO', () => service.preview.toggle(surface));
    }
    if (service) ui.onClick('DT_STOP', service.preview.stop);

    function render() {
        if (!ui.isVisible('MAIN')) return;
        if (renderLanguage()) changes.clear();
        const state = service && service.snapshot();
        const status = service && service.preview.current() ? t('Demo active', 'Demo activ') :
            !state || !state.ready ? t('Waiting for READY', 'Asteapta READY') :
                state.live ? t('Temperatures visible', 'Temperaturi afisate') :
                    t('No cool sensors to display', 'Niciun senzor rece disponibil');
        write('DT_STATUS', status, v => ui.text('DT_STATUS', v));
        write('DT_MODE', settings.get('mode') === 'always' ? 1 : 0, v => ui.selected('DT_MODE', v));
        for (const [index, sensor] of SENSORS.entries()) {
            const id = 'DT_WARM' + index, limit = settings.get(sensor.id + 'Warm');
            write(sensor.id, settings.get(sensor.id), v => ui.checked('DT_SENSOR' + index, v));
            const reading = state && state.readings[index];
            const text = t(...sensor.label) + ' · ' + (Number.isFinite(reading) ? reading + ' °C' : '—');
            write('DT_LIVE' + index, text, v => ui.text('DT_LIVE' + index, v));
            write(id, limit, v => {
                ui.cells(id, 0, { TextDescription: t('Warm at ', 'Cald la ') + v + ' °C' });
                const component = ui.comp(id);
                if (component && component.setStepValue) component.setStepValue((v - sensor.min) / 5);
            });
        }
        for (const [surface, { key }] of Object.entries(TARGETS)) {
            const prefix = 'DT_' + surface.toUpperCase(), id = prefix + '_SIZE';
            write(prefix + '_ON', settings.get(key), v => ui.checked(prefix + '_ON', v));
            write(id, settings.get(key + 'Size'), step => {
                ui.cells(id, 0, { TextDescription: t('Size ', 'Marime ') + SIZES[step] + '%' });
                const component = ui.comp(id);
                if (component && component.setStepValue) component.setStepValue(step);
            });
            const position = t('Offset ', 'Decalaj ') + settings.get(key + 'X') + ', ' + settings.get(key + 'Y') + ' px';
            write(prefix + '_POS', position, v => ui.text(prefix + '_POS', v));
        }
    }
    settings.onChange(render);
    let timer;
    function visible(open) {
        clearInterval(timer);
        if (!open) { if (service) service.preview.stop(); return; }
        changes.clear(); render();
        timer = setInterval(render, 1000);
    }
    ui.onVisible((screen, open) => { if (screen === 'MAIN') visible(open); });
    app.on('shutdown', () => visible(false));
    visible(ui.isVisible('MAIN'));
}

mgu.run({ background, start });
