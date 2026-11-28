'use strict';

// Reattach a failed startup watch and optionally refresh readable fields
// when a provider missed a notification during its own restart.
function watchRetry(signals, iface, instance, handlers, log, options = {}) {
    let stopped = false, sub, timer, reading = false, epoch = 0;
    const received = new Map();
    const hooks = {};
    for (const key of Object.keys(handlers)) {
        hooks[key] = value => {
            if (stopped) return;
            received.set(key, (received.get(key) || 0) + 1);
            handlers[key](value);
        };
    }
    function next(callback, delay) {
        clearTimeout(timer);
        if (!stopped) {
            timer = setTimeout(callback, delay);
            if (timer.unref) timer.unref();
        }
    }
    function refresh() {
        const proxy = sub && sub.proxy;
        if (stopped || !proxy || !proxy.getValue || reading || options.poll && !options.poll()) return;
        reading = true;
        const generation = epoch;
        Promise.all(Object.keys(hooks).map(key => {
            const seen = received.get(key);
            return Promise.resolve().then(() => proxy.getValue(key, 2000)).then(value => {
                if (value !== undefined && value !== null && sub && sub.proxy === proxy &&
                    generation === epoch && received.get(key) === seen) {
                    sub.available = true;
                    hooks[key](value);
                }
            }).catch(() => {});
        })).then(() => { reading = false; });
    }
    function poll() {
        refresh();
        if (options.pollMs) next(poll, options.pollMs);
    }
    async function attach() {
        try {
            const current = await signals.watch(iface, instance, hooks, log, {
                onAvailability: available => {
                    if (stopped) return;
                    if (!available) epoch++;
                    if (options.onAvailability) options.onAvailability(available);
                    if (available) refresh();
                },
            });
            if (stopped) { await current.shutdown(); return; }
            if (current.error && !current.proxy) throw new Error(current.error);
            sub = current;
            if (options.onAttach) options.onAttach(current);
            if (options.pollMs) next(poll, options.pollMs);
        } catch (error) {
            if (stopped) return;
            if (!/no SOME\/IP config|native module not available/i.test(String(error))) next(attach, 10000);
            if (log) log.warn(iface + ' watch: ' + error.message);
        }
    }
    attach();
    return {
        refresh,
        stop() {
            stopped = true;
            clearTimeout(timer);
            if (sub) Promise.resolve(sub.shutdown()).catch(() => {});
        },
    };
}

module.exports = { watchRetry };
