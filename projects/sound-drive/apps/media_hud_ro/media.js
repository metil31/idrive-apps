'use strict';

function field(value, key) {
    if (value && Object.prototype.hasOwnProperty.call(value, 'value')) value = value.value;
    if (!value || !Object.prototype.hasOwnProperty.call(value, key)) return value;
    const member = value[key];
    return member && Object.prototype.hasOwnProperty.call(member, 'value') ? member.value : member;
}

function textValue(value) {
    if (value && typeof value === 'object') value = value.stringValue;
    return typeof value === 'string' ? value.slice(0, 300).replace(/[\x00-\x1f\x7f]/g, ' ').trim() : '';
}

function decodeTrack(value) {
    const data = field(value, 'currentItemMetadata');
    let title = '', artist = '';
    if (Array.isArray(data)) {
        for (const entry of data) {
            if (!entry) continue;
            const key = String(entry.key || entry.type || '').toUpperCase();
            const value = entry.value === undefined ? entry.stringValue : entry.value;
            if (key === 'TITLE') title = textValue(value);
            if (key === 'ARTIST') artist = textValue(value);
        }
    } else if (data && typeof data === 'object') {
        title = textValue(data.TITLE || data.title);
        artist = textValue(data.ARTIST || data.artist);
    }
    return title ? { title, artist } : null;
}

function isPlaying(value) {
    const state = field(value, 'playerState');
    const name = state && typeof state === 'object' ? state.name : state;
    return name === 'PLAYER_STATE_PLAY' || name === 'PLAY';
}

module.exports = { decodeTrack, isPlaying, field };
