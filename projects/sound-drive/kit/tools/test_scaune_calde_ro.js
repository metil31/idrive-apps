'use strict';

const assert = require('assert');
const { createService, exteriorTemperature } = require('../../apps/scaune_calde_ro/service');
const { createBdc, CONFIRM_GAP_MS } = require('../../apps/scaune_calde_ro/bdc');
const { replyTo } = require('../runtime/diag');

function fixture(overrides) {
    let now = 1000, armed = false, state = [0, 0];
    const commands = [];
    const settings = Object.assign({ auto: true, threshold: 8, driver: true, passenger: true, level: 2 }, overrides);
    const marker = { load: () => armed, save: (value) => { armed = value; } };
    const diag = {
        async physical(address, service, data, timeout, accept, opts) {
            assert.strictEqual(opts.maxRetries, 0);
            if (address === 0x6D || address === 0x6E) return overrides && overrides.module ?
                [0x62, 0xF1, 0x50, 15, 33, 240] : [0x7F, 0x22, 0x25];
            if (data[0] === 0xF1) return [0x62, 0xF1, 0x50, 15, 38, 128];
            const index = data[1] === 0x32 ? 0 : 1;
            if (service === 0x22) return [0x62, ...data, state[index] ? 1 : 0, state[index], 10, 11, 0, 0, 0];
            commands.push(data);
            state[index] = data[2];
            return overrides && overrides.noAck ? null : [0x6E, data[0], data[1]];
        },
    };
    function make() {
        return createService({ get: (k) => settings[k] }, marker,
            () => createBdc(diag, replyTo, () => now), () => now, CONFIRM_GAP_MS);
    }
    return {
        make, commands, settings,
        advance(ms) { now += ms; },
        setLevels(levels) { state = levels; },
    };
}

async function start(service, outside) {
    service.observeCondition(5);
    service.observeCondition(8);
    service.observeCondition(10);
    service.observeTemperature(outside);
    service.observeSpeed(0);
    await service.tick();
}

async function next(f, service) {
    f.advance(CONFIRM_GAP_MS);
    service.observeSpeed(0);
    await service.tick();
}

async function test() {
    assert.strictEqual(exteriorTemperature(0), -40);
    assert.strictEqual(exteriorTemperature(90), 5);
    assert.strictEqual(exteriorTemperature(255), null);
    let f = fixture(), service = f.make();
    await start(service, 90);
    assert.deepStrictEqual(f.commands, []);
    await next(f, service);
    assert.deepStrictEqual(f.commands, [[0xE4, 0x32, 2, 180], [0xE4, 0x30, 2, 180]]);
    f.setLevels([0, 0]);
    service.observeCondition(10);
    await next(f, service);
    assert.strictEqual(f.commands.length, 2, 'manual OFF must not restart heating');
    service = f.make();
    service.observeCondition(10);
    service.observeTemperature(90);
    await next(f, service);
    assert.strictEqual(f.commands.length, 2, 'process restart must not simulate vehicle restart');
    await start(service, 90);
    await next(f, service);
    assert.strictEqual(f.commands.length, 4, 'next actual startup is eligible again');

    for (const variant of [{ auto: false }, { module: true }, { threshold: 5 }]) {
        f = fixture(variant); service = f.make();
        await start(service, 90);
        await next(f, service);
        assert.strictEqual(f.commands.length, 0);
    }
    f = fixture({ passenger: false, noAck: true }); service = f.make();
    await start(service, 90);
    await next(f, service);
    await next(f, service);
    assert.deepStrictEqual(f.commands, [[0xE4, 0x32, 2, 180]], 'no resend after a missing acknowledgement');

    f = fixture(); service = f.make();
    await start(service, 90);
    service.observeSpeed(1);
    await next(f, service);
    assert.strictEqual(f.commands.length, 0, 'moving away cancels this startup');

    f = fixture(); service = f.make();
    await start(service, 96);
    service.observeTemperature(90);
    await next(f, service);
    assert.strictEqual(f.commands.length, 0, 'cooling later must not start heating');

    f = fixture(); service = f.make();
    await start(service, 90);
    service.observeCondition(12);
    await next(f, service);
    assert.strictEqual(f.commands.length, 0, 'ending readiness cancels pending activation');

    f = fixture(); service = f.make();
    f.setLevels([1, 0]);
    await start(service, 90);
    await next(f, service);
    assert.deepStrictEqual(f.commands, [[0xE4, 0x30, 2, 180]], 'leave a heating seat alone');
    console.log('Scaune calde: prag, scaune separate, pornire unică și protecții verificate');
}

test().catch((err) => { console.error(err); process.exitCode = 1; });
