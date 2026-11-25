'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const spec = require('../../apps/media_hud_ro/app.json');
const { wireMenu } = require('../../apps/media_hud_ro/menu');

const screen = spec.screens[0];
assert.strictEqual(screen.name, 'MAIN');
assert.strictEqual(screen.kind, 'menu');
assert.strictEqual(screen.settings, true);
const controls = new Map(screen.items.map((item) => [item[1], item[0]]));
const click = new Map(), current = new Map(), components = new Map();
for (const id of ['MR_HUD_SIZE', 'MR_CL_SIZE']) {
    const slider = new EventEmitter();
    slider.setStepValue = (value) => current.set(id + ':step', value);
    components.set(id, slider);
}
const values = new Map(spec.settings.map((entry) => [entry.key, entry.default]));
values.set('positionX', 90);
values.set('positionY', 350);
const listeners = [];
const settings = {
    item: (key) => spec.settings.find((entry) => entry.key === key),
    get: (key) => values.get(key),
    set: (key, value) => { values.set(key, value); listeners.forEach((listener) => listener(key, value)); },
    onChange: (listener) => listeners.push(listener),
};
const app = new EventEmitter(), tab = new EventEmitter();
const ui = {
    isVisible: () => true,
    comp: (id) => components.get(id),
    checked: (id, value) => current.set(id, value),
    selected: (id, value) => current.set(id, value),
    text: (id, value) => current.set(id, value),
    cells: (id, row, cells) => current.set(id + ':' + row, cells),
    enabled: (id, value) => current.set(id + ':enabled', value),
    onClick: (id, fn) => { assert.ok(controls.has(id)); click.set(id, fn); },
    onVisible: (fn) => tab.on('visible', fn),
    open: () => assert.fail('position controls must stay on the current page'),
};

wireMenu({ ui, settings, app, background: { status: () => 'Media pe HUD', track: () => null } });
try {
    const press = (id, event) => click.get(id)(event || {});
    press('MR_HUD_RIGHT');
    press('MR_HUD_RIGHT');
    press('MR_HUD_UP');
    assert.strictEqual(settings.get('positionX'), 110);
    assert.strictEqual(settings.get('positionY'), 340);
    assert.match(current.get('MR_HUD_POS'), /110 px.*340 px/);
    assert.strictEqual(current.get('MR_CL_DOWN:enabled'), false);
    press('MR_SHOW', { row: 2 });
    assert.strictEqual(current.get('MR_CL_DOWN:enabled'), true);
    press('MR_CL_DOWN');
    press('MR_CL_LEFT');
    assert.strictEqual(settings.get('clusterY'), 95);
    assert.strictEqual(settings.get('clusterX'), -10);
    assert.strictEqual(settings.get('positionX'), 110);
    settings.set('clusterY', 435);
    assert.strictEqual(current.get('MR_CL_DOWN:enabled'), false);
    press('MR_CL_DOWN');
    assert.strictEqual(settings.get('clusterY'), 435);
    press('MR_CL_RESET');
    assert.strictEqual(settings.get('clusterY'), 85);
    assert.strictEqual(settings.get('clusterX'), 0);
    components.get('MR_HUD_SIZE').emit('changed', 8);
    assert.strictEqual(settings.get('hudSize'), 150);
    assert.strictEqual(settings.get('clusterSize'), 100);
    press('MR_ART');
    assert.strictEqual(settings.get('albumArt'), true);
} finally {
    tab.emit('visible', 'MAIN', false);
    app.emit('shutdown');
}
console.log('Media native menu: 10 px movement, independent sliders and same-page controls verified');
