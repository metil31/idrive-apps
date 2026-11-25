'use strict';

// Vehicle-specific commands documented by Heating Comfort. Only the BDC_G05
// path for front seats without a separate controller is enabled here.
const BDC = 0x40;
const IDENTIFY = [0xF1, 0x50];
const SEATS = {
    driver: { module: 0x6D, did: [0xE4, 0x32] },
    passenger: { module: 0x6E, did: [0xE4, 0x30] },
};
const HEAT_SECONDS = 180;
const CONFIRM_GAP_MS = 20000;

function createBdc(diag, replyTo, now) {
    const absence = {};
    const request = (address, service, data) => diag.physical(
        address, service, data, 2500, replyTo(service, data),
        { maxRetries: 0, callTimeoutMs: 3000, hardTimeoutMs: 5000 });
    const read = (address, data) => request(address, 0x22, data);
    async function seat(side) {
        const u = await read(BDC, SEATS[side].did);
        if (!u || u[0] !== 0x62 || u.length < 10) return null;
        if ((u[3] !== 0 && u[3] !== 1) || u[4] < 0 || u[4] > 3 ||
            (u[3] === 0) !== (u[4] === 0)) return null;
        return { level: u[4], restricted: u[7] !== 0 || u[8] !== 0 };
    }
    async function identity() {
        const u = await read(BDC, IDENTIFY);
        if (!u || u[0] !== 0x62) return null;
        return u[3] === 0x0F && u[4] === 0x26 && u[5] === 0x80;
    }
    async function check(side, allowed) {
        const initial = await seat(side);
        if (!allowed()) return 'cancelled';
        if (!initial) return 'unsupported';
        if (initial.level) return 'already';
        if (initial.restricted) return 'restricted';
        const u = await read(SEATS[side].module, IDENTIFY);
        if (!allowed()) return 'cancelled';
        // A separate controller or an inconclusive refusal blocks this path.
        if (u && !(u[0] === 0x7F && u[1] === 0x22 && u[2] === 0x25)) {
            absence[side] = null;
            return 'unsupported';
        }
        const at = now();
        if (absence[side] == null) absence[side] = at;
        return at - absence[side] >= CONFIRM_GAP_MS ? 'ready' : 'checking';
    }
    async function heat(side, level, allowed) {
        if (!Number.isInteger(level) || level < 1 || level > 3 ||
            absence[side] == null || now() - absence[side] < CONFIRM_GAP_MS ||
            !allowed()) return 'cancelled';
        const before = await seat(side);
        if (!allowed()) return 'cancelled';
        if (!before) return 'unsupported';
        if (before.level) return 'already';
        if (before.restricted) return 'restricted';
        const u = await request(BDC, 0x2E, SEATS[side].did.concat(level, HEAT_SECONDS));
        if (!u || u[0] !== 0x6E) return 'unconfirmed';
        if (!allowed()) return 'accepted';
        const after = await seat(side);
        return after && after.level === level ? 'reported' : 'accepted';
    }
    return { identity, check, heat };
}

module.exports = { createBdc, CONFIRM_GAP_MS };
