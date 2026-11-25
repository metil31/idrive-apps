'use strict';

const fs = require('fs');
const COVER_PATH = /^\/tmp\/mediaramdisk_hu\/covers\/[a-z0-9][a-z0-9_.-]{0,120}\.jpe?g$/i;
const MAX_BYTES = 1024 * 1024;

function readCover(file) {
    return new Promise((resolve) => {
        if (!COVER_PATH.test(file)) { resolve(null); return; }
        fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0), (error, fd) => {
            if (error) { resolve(null); return; }
            const finish = (image) => fs.close(fd, () => resolve(image));
            fs.fstat(fd, (statError, stat) => {
                if (statError || !stat.isFile() || stat.size < 4 || stat.size > MAX_BYTES) { finish(null); return; }
                const bytes = Buffer.alloc(stat.size);
                fs.read(fd, bytes, 0, bytes.length, 0, (readError, n) => {
                    if (readError || n !== bytes.length || bytes[0] !== 255 || bytes[1] !== 216) { finish(null); return; }
                    finish({ bytes, stamp: stat.mtimeMs + ':' + stat.size });
                });
            });
        });
    });
}

class AlbumArt {
    constructor(load = readCover, decode = null, now = Date.now) {
        this.load = load;
        this.decode = decode;
        this.now = now;
        this.current = null;
        this.last = null;
    }

    get(track, enabled) {
        if (!enabled || !track || !COVER_PATH.test(track.cover || '')) {
            this.current = null;
            return null;
        }
        const song = JSON.stringify([track.title, track.artist]), file = track.cover;
        if (!this.current || this.current.song !== song || this.current.file !== file) {
            this.current = { song, file, attempts: 0, next: 0, pending: false, image: null };
        }
        const slot = this.current;
        if (slot.image || slot.pending || slot.attempts >= 4 || this.now() < slot.next) return slot.image;
        slot.pending = true;
        slot.attempts++;
        this.load(file).then((data) => {
            if (!data || slot !== this.current) return;
            if (this.last && this.last.file === file && this.last.song !== song && this.last.stamp === data.stamp) return;
            const decode = this.decode || require('./jpeg_decoder');
            slot.image = decode(data.bytes, { useTArray: true, maxMemoryUsageInMB: 32, maxResolutionInMP: 2 });
            this.last = { file, song, stamp: data.stamp };
        }).catch(() => {}).then(() => {
            slot.pending = false;
            slot.next = this.now() + 1000;
        });
        return null;
    }
}

module.exports = { AlbumArt };
