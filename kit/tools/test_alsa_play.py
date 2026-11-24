"""
Test für tools/iconix-audiod/alsa_play.py ohne Head Unit: eine simulierte Soundkarte (libasound-Ersatz) und ein
simuliertes select(). Prüft die Wiedergabe-Schleife "play":
  - alle Daten von stdin landen vollständig und in der richtigen Reihenfolge im Gerät
  - zu Beginn 20 ms Stille, Rückmeldungen "P <Frames>" auf stdout, steigend
  - stockt der Dienst, legt der Player Stille nach (statt leerzulaufen) und meldet "underrun"
Aufruf:  python kit/tools/test_alsa_play.py
"""
import array
import importlib.util
import io
import math
import os
import sys
import tempfile
import types

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
spec = importlib.util.spec_from_file_location('alsa_play', os.path.join(ROOT, 'tools', 'iconix-audiod', 'alsa_play.py'))
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)

RATE = 24000
BUF = 960  # 40 ms


class FakePcm:
    """Gerät mit 40-ms-Puffer, das in simulierter Zeit abspielt (Zeit läuft in select() und beim blockierenden Schreiben)."""

    def __init__(self):
        self.t = 0.0          # simulierte Sekunden
        self.fill = 0         # Frames im Puffer
        self.running = False
        self.out = bytearray()
        self.played_at = 0.0

    def advance(self, dt):
        self.t += dt
        if self.running:
            self.fill = max(0, self.fill - int(round(dt * RATE)))


def make_lib(pcm):
    lib = types.SimpleNamespace()
    lib.snd_pcm_open = lambda *a: 0
    lib.snd_pcm_set_params = lambda *a: 0
    lib.snd_pcm_close = lambda h: 0
    lib.snd_strerror = lambda c: b'err'

    def get_params(h, b, p):
        b._obj.value = BUF
        p._obj.value = BUF // 4
        return 0
    lib.snd_pcm_get_params = get_params

    def writei(h, data, n):
        n = int(n)
        room = BUF - pcm.fill
        if room <= 0:
            # blockiert, bis Platz ist: Zeit läuft weiter
            if not pcm.running:
                pcm.running = True
            pcm.advance(0.005)
            room = BUF - pcm.fill
        w = min(n, room)
        pcm.out += bytes(data[:w * 2])
        pcm.fill += w
        if pcm.fill >= BUF:
            pcm.running = True
        return w
    lib.snd_pcm_writei = writei

    def delay(h, d):
        d._obj.value = pcm.fill
        return 0
    lib.snd_pcm_delay = delay
    lib.snd_pcm_state = lambda h: 3 if pcm.running else ap.SND_PCM_STATE_PREPARED

    def start(h):
        pcm.running = True
        return 0
    lib.snd_pcm_start = start
    lib.snd_pcm_recover = lambda h, e, s: 0
    return lib


def run(payload, stall_reads):
    """payload: Bytes auf stdin; stall_reads: Menge von select()-Aufrufnummern, bei denen 'nichts da' simuliert wird."""
    pcm = FakePcm()
    lib = make_lib(pcm)
    ap.load_alsa = lambda: lib
    ap.open_pcm = lambda l, dev, rate, lat, nonblock=False, channels=2: (1, None)

    calls = {'n': 0}

    def fake_select(r, w, x, timeout):
        calls['n'] += 1
        if calls['n'] in stall_reads:
            pcm.advance(timeout)
            return [], [], []
        return r, [], []
    sys.modules['select'] = types.SimpleNamespace(select=fake_select)

    with tempfile.TemporaryFile() as f:
        f.write(payload)
        f.seek(0)
        rfd, wfd = os.pipe()
        old_in, old_out_fd = sys.stdin, os.dup(1)
        sys.stdin = io.TextIOWrapper(io.BufferedReader(io.FileIO(f.fileno(), closefd=False)))
        os.dup2(wfd, 1)
        err = io.StringIO()
        old_err = sys.stderr
        sys.stderr = err
        try:
            rc = ap.cmd_play('test', RATE, 40000, 1)
        finally:
            os.dup2(old_out_fd, 1)
            os.close(old_out_fd)
            os.close(wfd)
            sys.stdin = old_in
            sys.stderr = old_err
        reports = b''
        while True:
            chunk = os.read(rfd, 65536)
            if not chunk:
                break
            reports += chunk
        os.close(rfd)
    return rc, pcm, reports.decode(), err.getvalue()


def main():
    fails = 0
    # 0,5 s Rampe als Mono-S16LE
    frames = RATE // 2
    payload = b''.join(int((i % 3000) - 1500).to_bytes(2, 'little', signed=True) for i in range(frames))
    pre = 2 * (RATE * 10 // 1000)  # 20 ms Stille zu Beginn

    rc, pcm, rep, err = run(payload, stall_reads=set())
    ok = rc == 0 and bytes(pcm.out[pre * 2:]) == payload and bytes(pcm.out[:pre * 2]) == bytes(pre * 2)
    print(('ok  ' if ok else 'FAIL') + ' Daten vollständig, in Reihenfolge, 20 ms Stille davor')
    fails += not ok
    vals = [int(l[2:]) for l in rep.split('\n') if l.startswith('P ')]
    ok = len(vals) > 3 and all(b >= a for a, b in zip(vals, vals[1:]))
    print(('ok  ' if ok else 'FAIL') + ' Rückmeldungen "P <Frames>" steigend (%d)' % len(vals))
    fails += not ok

    rc, pcm, rep, err = run(payload, stall_reads=set(range(5, 40)))
    zeros_inside = len(pcm.out) - len(payload) - pre * 2
    # Daten müssen vollständig enthalten sein, Stille nur dazwischen
    data = bytes(pcm.out)
    ok = rc == 0 and zeros_inside > 0 and 'underrun' in err and len(data) == len(payload) + pre * 2 + zeros_inside
    print(('ok  ' if ok else 'FAIL') + ' stockender Dienst: Stille nachgelegt (%d ms), als underrun gemeldet' % (zeros_inside // 2 * 1000 // RATE))
    fails += not ok
    # Rückmeldung zählt nur Frames des Dienstes: nachgelegte Stille darf nicht als gespielt gelten (sonst schreibt der
    # Dienst danach zu viel vor und die Verzögerung wächst mit jedem Stocken)
    vals = [int(l[2:]) for l in rep.split('\n') if l.startswith('P ')]
    ok = bool(vals) and max(vals) <= frames
    print(('ok  ' if ok else 'FAIL') + ' Rückmeldung ohne nachgelegte Stille (höchstens %d, gemeldet %d)' % (frames, max(vals or [0])))
    fails += not ok
    # kein Knacken: an den Rändern des Stockens keine Sprünge (leiser Sinus, größter Schritt zwischen zwei Samples)
    sine = b''.join(int(9000 * math.sin(2 * math.pi * 90 * i / RATE)).to_bytes(2, 'little', signed=True) for i in range(frames))
    rc, pcm, rep, err = run(sine, stall_reads=set(range(5, 40)))
    x = array.array('h', bytes(pcm.out))
    step = max(abs(x[i] - x[i - 1]) for i in range(pre + 50, len(x)))
    ok = rc == 0 and 'underrun' in err and step < 700   # 90 Hz: normal 212 je Sample; harte Stille spränge um bis zu 9000
    print(('ok  ' if ok else 'FAIL') + ' Stocken ohne Knacken (größter Sprung %d)' % step)
    fails += not ok
    # Stocken in der Stille hört man nicht: nicht als Aussetzer zählen
    rc, pcm, rep, err = run(bytes(frames * 2), stall_reads=set(range(5, 40)))
    ok = rc == 0 and 'underrun' not in err
    print(('ok  ' if ok else 'FAIL') + ' Stocken in der Stille zählt nicht')
    fails += not ok
    # zwei getrennte Hänger -> genau zwei Meldungen (je Stocken eine), Daten trotzdem vollständig
    rc, pcm, rep, err = run(payload, stall_reads=set(range(4, 9)) | set(range(14, 19)))
    n = err.count('underrun')
    data = bytes(pcm.out)
    ok = rc == 0 and n == 2 and len(data) > len(payload) + pre * 2
    print(('ok  ' if ok else 'FAIL') + ' zwei Hänger -> zwei Meldungen (%d)' % n)
    fails += not ok
    print('Alle alsa_play-Tests bestanden' if not fails else '%d Test(s) fehlgeschlagen' % fails)
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
