'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { captureFrame, captureTest } = require('../../apps/hud_romania/waze-capture');

async function verify() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waze-test-'));
    try {
        const testFrame = Buffer.alloc(1280 * 480 * 4);
        function whiteBox(x, y, w, h) {
            for (let row = y; row < y + h; row++) {
                testFrame.fill(255, (row * 1280 + x) * 4, (row * 1280 + x + w) * 4);
            }
        }
        whiteBox(340, 425, 100, 10);
        whiteBox(907, 48, 21, 20);
        whiteBox(970, 54, 34, 15);
        const result = await captureFrame(dir, (file, args, opts, done) => {
            assert.strictEqual(file, 'winston-grabber');
            assert.deepStrictEqual(args.slice(0, -1), ['-s', 'center', '-n', '1']);
            assert.strictEqual(opts.timeout, 6000);
            fs.writeFileSync(args[args.length - 1], testFrame);
            done(null);
        });
        assert.deepStrictEqual(result.matches.dashboard, { eta: true, turn: true });
        assert.deepStrictEqual(result.matches.full, { eta: false, turn: false });
        assert.deepStrictEqual(fs.readdirSync(dir), [], 'screen pixels are removed after the test');
        const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        try {
            await captureFrame(dir, (file, args, opts, done) => done(failure));
            assert.fail('capture errors must be returned to the app');
        } catch (e) { assert.strictEqual(e, failure); }
        assert.deepStrictEqual(fs.readdirSync(dir), []);
        let time = 0, pending, captured = 0;
        const clock = { now: () => time, setTimeout: (fn) => { pending = fn; return 1; }, clearTimeout: () => { pending = null; } };
        const ctl = captureTest(dir, () => { captured++; return Promise.resolve(result); }, clock);
        ctl.start();
        ctl.start();
        assert.match(ctl.status(), /12 s/);
        assert.strictEqual(captured, 0, 'waits for the user to switch to CarPlay');
        time = 12000;
        pending();
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(captured, 1);
        assert.match(ctl.status(), /Compact: ETA și viraj/);
        ctl.start();
        ctl.stop();
        assert.strictEqual(pending, null);
    } finally { fs.rmdirSync(dir); }
}

verify().then(() => console.log('Waze capture diagnostic: timer, raw frame, errors and cleanup verified'), (e) => {
    console.error(e);
    process.exitCode = 1;
});
