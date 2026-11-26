'use strict';

const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { conditionOf } = require('./kit/car');
const { Diag, replyTo } = require('./kit/diag');
const { createBdc, CONFIRM_GAP_MS } = require('./bdc');
const { createService, MESSAGES } = require('./service');
const { menuLanguage } = require('./kit/menu-language');

function background(ctx) {
    const { app, settings, signals, log, dataDir } = ctx;
    const file = path.join(dataDir, 'observed-power-state');
    const marker = {
        load() {
            try { return fs.readFileSync(file, 'utf8') === 'off'; }
            catch (err) { return false; }
        },
        save(armed) { mgu.Settings.writeWhole(file, armed ? 'off' : 'consumed'); },
    };
    let diag, stopped = false, speedWatch, readingSpeed = false;
    const watches = [];
    const service = createService(settings, marker, async () => {
        if (!diag) diag = await new Diag(signals, log).init();
        if (!diag.p) throw new Error('Modulul de diagnoză nu a răspuns');
        return createBdc(diag, replyTo, Date.now);
    }, Date.now, CONFIRM_GAP_MS);

    function watch(name, field, handler) {
        return signals.watch(name, '1', { [field]: handler }, log).then((watcher) => {
            if (stopped) watcher.shutdown();
            else watches.push(watcher);
            return watcher;
        }).catch((err) => log.warn(name + ': ' + err));
    }
    watch('de.bmw.infrastructure.VehicleCondition', 'VehicleCondition',
        (value) => {
            const raw = value && value.statusConditionVehicle;
            service.observeCondition(conditionOf(typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw));
        });
    watch('de.bmw.infrastructure.EnvironmentalInformation', 'ExteriorTemperature',
        (value) => service.observeTemperature(value && value.temperatureExterior));
    const readSpeed = (value) => service.observeSpeed(value && value.speedVehicleCentreOfGravity);
    watch('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', readSpeed)
        .then((watcher) => { speedWatch = watcher; });
    settings.onChange(key => { if (key !== 'menuLanguage') service.cancel(); });
    const timer = setInterval(() => {
        if (service.needsSpeed() && speedWatch && speedWatch.proxy && !readingSpeed) {
            readingSpeed = true;
            speedWatch.proxy.getValue('statusCarSpeed2', 2000).then(readSpeed).catch(() => {})
                .then(() => { readingSpeed = false; });
        }
        service.tick();
    }, 1000);
    app.on('shutdown', () => {
        stopped = true;
        clearInterval(timer);
        service.stop();
        watches.forEach((watcher) => watcher.shutdown());
        if (diag && diag.p && diag.p.shutdown) diag.p.shutdown();
    });
    return service;
}

function start(ctx) {
    const { app, ui, settings, background } = ctx;
    const language = menuLanguage(ctx), { t } = language;
    const status = value => MESSAGES[value] ? t(...MESSAGES[value]) : value;
    const switches = { SC_AUTO: 'auto', SC_DRIVER: 'driver', SC_PASSENGER: 'passenger' };
    const slider = ui.comp('SC_THRESHOLD');
    const shown = {};
    function show(key, value, update) {
        if (shown[key] === value) return;
        shown[key] = value;
        update(value);
    }
    function set(key, value) { if (settings.get(key) !== value) settings.set(key, value); }
    for (const id of Object.keys(switches)) {
        const key = switches[id];
        ui.onClick(id, () => set(key, settings.get(key) !== true));
    }
    ui.onClick('SC_LEVEL', (event) => {
        if (Number.isInteger(event.row) && event.row >= 0 && event.row <= 2) set('level', event.row + 1);
    });
    if (slider && slider.on) slider.on('changed', (step) => {
        if (!Number.isInteger(step) || step < 0 || step > 20) return;
        shown.step = step;
        set('threshold', step - 5);
    });
    function render() {
        if (!ui.isVisible('MAIN')) return;
        if (language.render()) Object.keys(shown).forEach(key => delete shown[key]);
        for (const id of Object.keys(switches)) {
            show(id, settings.get(switches[id]) === true, (v) => ui.checked(id, v));
        }
        show('level', settings.get('level') - 1, (v) => ui.selected('SC_LEVEL', v));
        const threshold = settings.get('threshold');
        show('threshold', threshold, (v) => ui.cells('SC_THRESHOLD', 0, { TextDescription: t('Below ', 'Sub ') + v + ' °C' }));
        show('step', threshold + 5, (v) => {
            if (slider && slider.setStepValue) slider.setStepValue(v);
            else ui.cells('SC_THRESHOLD', 0, { Value: v });
        });
        const state = background ? background.snapshot() : { outdoor: null, result: t('Service unavailable', 'Serviciu indisponibil') };
        const lines = {
            SC_TEMP: t('Outside · ', 'Exterior · ') + (state.outdoor === null ? t('unavailable', 'indisponibil') : state.outdoor + ' °C'),
            SC_RESULT: status(state.result),
            SC_LIVE_DRIVER: t('Driver · ', 'Sofer · ') + (status(state.driver) || '—'),
            SC_LIVE_PASSENGER: t('Passenger · ', 'Pasager · ') + (status(state.passenger) || '—'),
        };
        for (const id of Object.keys(lines)) show(id, lines[id], (v) => ui.text(id, v));
    }
    settings.onChange(render);
    let timer;
    function visible(open) {
        clearInterval(timer);
        if (!open) return;
        render();
        timer = setInterval(render, 1000);
    }
    ui.onVisible((name, open) => { if (name === 'MAIN') visible(open); });
    app.on('shutdown', () => visible(false));
    visible(ui.isVisible('MAIN'));
}

mgu.run({ background, start });
