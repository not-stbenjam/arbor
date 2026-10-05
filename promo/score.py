#!/usr/bin/env python3
"""The promotional video's soundtrack, made from nothing but arithmetic.

Every sound here is synthesized: there are no samples and no recordings, so
there is nothing to license. The music is in F major at 120 beats a minute,
which puts a beat on every half second and a bar on every two, and it reads
the same timeline the picture does (composition/timeline.js), so a click in
the picture and a click in the sound are the same moment.

    python promo/score.py OUT.wav
"""

import json
import re
import sys
from pathlib import Path

import numpy as np
from scipy import signal

SR = 48000
TIMELINE = json.loads(
    re.search(r"=\s*(\{.*\})\s*;", (Path(__file__).parent / "composition" / "timeline.js").read_text(), re.S).group(1)
)
DURATION = TIMELINE["duration"]
BEAT = 60 / TIMELINE["bpm"]
BAR = 4 * BEAT
N = int(SR * (DURATION + 4))  # room for tails, cut at the end
rng = np.random.default_rng(20261006)


def hz(note):
    """The frequency of a MIDI note number."""
    return 440.0 * 2 ** ((note - 69) / 12)


def seconds(n):
    return np.arange(int(n * SR)) / SR


def envelope(length, attack, decay, sustain=0.0, release=0.0, hold=0.0):
    """Attack, hold, decay to a level, release: all in seconds."""
    n = int(length * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    a = t < attack
    out[a] = t[a] / max(attack, 1e-6)
    h = (t >= attack) & (t < attack + hold)
    out[h] = 1.0
    d = t >= attack + hold
    out[d] = sustain + (1 - sustain) * np.exp(-(t[d] - attack - hold) / max(decay, 1e-6))
    if release > 0:
        r = t > length - release
        out[r] *= np.clip((length - t[r]) / release, 0, 1) ** 1.5
    return out


def lowpass(x, cutoff, order=2):
    return signal.sosfilt(signal.butter(order, min(cutoff, SR * 0.45), "low", fs=SR, output="sos"), x)


def highpass(x, cutoff, order=2):
    return signal.sosfilt(signal.butter(order, cutoff, "high", fs=SR, output="sos"), x)


def bandpass(x, low, high, order=2):
    return signal.sosfilt(signal.butter(order, [low, min(high, SR * 0.45)], "band", fs=SR, output="sos"), x)


def saw(freq, length, phase=0.0):
    """A sawtooth with no harmonics above what the sample rate can carry."""
    t = seconds(length)
    out = np.zeros_like(t)
    for k in range(1, int(min(40, (SR * 0.45) // freq)) + 1):
        out += np.sin(2 * np.pi * k * freq * t + k * phase) / k
    return out * (2 / np.pi)


class Mix:
    """A stereo tape to lay sounds on at a time, a level and a place."""

    def __init__(self):
        self.tape = np.zeros((N, 2))

    def add(self, sound, at, level=1.0, pan=0.0):
        start = int(at * SR)
        if start >= N or start < 0:
            return
        sound = np.asarray(sound)
        if sound.ndim == 1:
            # Equal power, -1 hard left to +1 hard right.
            angle = (pan + 1) * np.pi / 4
            sound = np.stack([sound * np.cos(angle), sound * np.sin(angle)], axis=1) * np.sqrt(2)
        end = min(N, start + len(sound))
        self.tape[start:end] += sound[: end - start] * level


# ------------------------------------------------------------ instruments --


def pad(notes, length, bright=1500.0, attack=0.5, release=1.2):
    """Slow strings: five slightly mistuned saws to a note, filtered soft."""
    total = length + release
    left = np.zeros(int(total * SR))
    right = np.zeros_like(left)
    for note in notes:
        for cents, side in ((-9, -0.8), (-4, 0.5), (0, 0.0), (5, -0.4), (10, 0.8)):
            voice = saw(hz(note) * 2 ** (cents / 1200), total, phase=rng.uniform(0, 6.28))
            left += voice * (1 - side) / 2
            right += voice * (1 + side) / 2
    shape = envelope(total, attack, 6.0, sustain=0.85, release=release)
    # The filter opens a little as the chord sounds, and closes again.
    swell = 0.5 + 0.5 * np.sin(np.pi * np.clip(seconds(total) / total, 0, 1))
    out = np.stack([left, right], axis=1) / (len(notes) * 2.2)
    dark = np.stack([lowpass(out[:, c], bright * 0.55) for c in (0, 1)], axis=1)
    open_ = np.stack([lowpass(out[:, c], bright * 1.5) for c in (0, 1)], axis=1)
    return (dark * (1 - swell[:, None] * 0.6) + open_ * swell[:, None] * 0.6) * shape[:, None]


def pluck(note, length=0.9, bright=0.5, damp=0.996):
    """A plucked string: a burst of noise going round a short loop."""
    period = SR / hz(note)
    whole = int(period)
    n = int(length * SR)
    burst = np.zeros(n)
    # A soft pick: the string is set going by noise with its edge taken off.
    burst[:whole] = lowpass(rng.uniform(-1, 1, whole), 1800 + 5000 * bright, order=4)
    # y[n] = x[n] + damp/2 * (y[n-whole] + y[n-whole-1]) is the string.
    a = np.zeros(whole + 2)
    a[0] = 1.0
    a[whole] = -damp * 0.5
    a[whole + 1] = -damp * 0.5
    out = signal.lfilter([1.0], a, burst)
    # The loop is a whole number of samples and a half, which is close to the
    # note but not on it, and further off the higher it is. Playing the
    # string back a shade faster or slower puts it in tune.
    sounding = SR / (whole + 0.5)
    out = np.interp(np.arange(0, n - 1, hz(note) / sounding), np.arange(n), out)
    out = np.pad(out, (0, max(0, n - len(out))))[:n]
    out = lowpass(out, 5200 + 5000 * bright)
    out *= envelope(length, 0.003, length * 0.45, release=0.05)
    return out / (np.max(np.abs(out)) + 1e-9)


def bell(note, length=2.2, shine=1.0):
    """A soft struck bell: one sine bending another, and fading fast."""
    t = seconds(length)
    f = hz(note)
    # The higher the note, the less it is bent: a high bell bent as far as a
    # low one rings with overtones too high to be carried, which come back
    # as a harsh edge.
    reach = min(1.0, 600.0 / f)
    index = (2.4 * shine * np.exp(-t / 0.35) + 0.25) * reach
    tone = np.sin(2 * np.pi * f * t + index * np.sin(2 * np.pi * f * 3.5 * t))
    if f * 7 < 9000:
        tone += 0.35 * np.sin(2 * np.pi * f * 2 * t + 0.6 * reach * np.exp(-t / 0.2) * np.sin(2 * np.pi * f * 7 * t))
    else:
        tone += 0.25 * np.sin(2 * np.pi * f * 2 * t) * np.exp(-t / 0.5)
    return tone * envelope(length, 0.004, length * 0.28, release=0.1) * 0.6


def keys(notes, length=1.6):
    """An electric piano chord, warm and a little hollow."""
    t = seconds(length)
    out = np.zeros_like(t)
    for note in notes:
        f = hz(note)
        out += np.sin(2 * np.pi * f * t + 1.1 * np.exp(-t / 0.5) * np.sin(2 * np.pi * f * t)) * (0.9 + 0.1 * np.sin(2 * np.pi * 4.5 * t))
    return lowpass(out / len(notes), 3200) * envelope(length, 0.006, length * 0.4, release=0.15)


def bass(note, length):
    t = seconds(length)
    f = hz(note)
    tone = np.sin(2 * np.pi * f * t) + 0.22 * np.sin(2 * np.pi * 2 * f * t + 0.6) + 0.14 * saw(f, length)
    return lowpass(tone, 600) * envelope(length, 0.008, length * 1.5, sustain=0.6, release=min(0.08, length / 3))


def kick(weight=1.0):
    t = seconds(0.42)
    pitch = 46 + 120 * np.exp(-t / 0.028)
    body = np.sin(2 * np.pi * np.cumsum(pitch) / SR) * np.exp(-t / 0.13)
    click = highpass(rng.uniform(-1, 1, len(t)), 3000) * np.exp(-t / 0.004) * 0.12
    return (body + click) * weight


def hat(length=0.05, open_=False):
    n = int((0.28 if open_ else length * 3) * SR)
    noise = highpass(rng.uniform(-1, 1, n), 7500, order=3)
    return noise * np.exp(-np.arange(n) / SR / (0.09 if open_ else length * 0.45))


def snap():
    n = int(0.22 * SR)
    t = np.arange(n) / SR
    noise = bandpass(rng.uniform(-1, 1, n), 1100, 4200)
    # Three quick strikes and a tail, like fingers or a soft clap.
    shape = sum(np.exp(-np.clip(t - d, 0, None) / 0.008) * (t >= d) for d in (0.0, 0.011, 0.021)) * 0.5
    shape += np.exp(-np.clip(t - 0.028, 0, None) / 0.06) * (t >= 0.028)
    return noise * shape


def whoosh(length, low, high, peak=0.5):
    """Air moving past: noise through a filter that travels."""
    n = int(length * SR)
    t = np.arange(n) / n
    noise = rng.uniform(-1, 1, n)
    out = np.zeros(n)
    bands = 24
    for i in range(bands):
        centre = low * (high / low) ** (i / (bands - 1))
        band = bandpass(noise, centre * 0.8, centre * 1.25)
        # Each band is loudest as the sweep passes it.
        out += band * np.exp(-(((t - (i / (bands - 1)) * 0.9) / 0.16) ** 2))
    shape = np.sin(np.pi * np.clip(t / 1.0, 0, 1)) ** 1.5
    shape = np.where(t < peak, (t / peak) ** 2.2, ((1 - t) / (1 - peak)) ** 1.6)
    return out * shape / (np.max(np.abs(out)) + 1e-9)


def tick():
    """A pointer's click: almost nothing, but exactly on time."""
    n = int(0.03 * SR)
    t = np.arange(n) / SR
    return (highpass(rng.uniform(-1, 1, n), 2500) * np.exp(-t / 0.0025) * 0.7 + np.sin(2 * np.pi * 1900 * t) * np.exp(-t / 0.006) * 0.5)


def blip(start, end, length=0.09):
    t = seconds(length)
    pitch = start * (end / start) ** (t / length)
    return np.sin(2 * np.pi * np.cumsum(pitch) / SR) * envelope(length, 0.004, length * 0.4, release=0.02)


def reverb(x, seconds_=2.4, bright=5200):
    """A room that was never built: noise that dies away, darker as it goes."""
    n = int(seconds_ * SR)
    t = np.arange(n) / SR
    out = np.zeros_like(x)
    for channel in (0, 1):
        noise = rng.normal(0, 1, n)
        room = lowpass(noise, bright) * np.exp(-t / (seconds_ / 6.9)) + highpass(noise, bright) * np.exp(-t / (seconds_ / 16)) * 0.5
        room[: int(0.012 * SR)] = 0  # a moment before the first reflection
        room /= np.sqrt(np.sum(room**2))
        out[:, channel] = signal.fftconvolve(x[:, channel], room)[: len(x)]
    return out


def echo(x, delay, feedback=0.35, repeats=5):
    """Repeats that cross from side to side and dull as they go."""
    out = np.zeros_like(x)
    step = int(delay * SR)
    tap = x.copy()
    for i in range(1, repeats + 1):
        tap = np.stack([lowpass(tap[:, 1], 3800), lowpass(tap[:, 0], 3800)], axis=1) * feedback
        if i * step >= len(x):
            break
        out[i * step :] += tap[: len(x) - i * step]
    return out


# ------------------------------------------------------------------ music --

F, C, DM, BB = "F", "C", "Dm", "Bb"
CHORDS = {
    #      bass  pad (low to high)      arpeggio, an octave up
    F: (41, [57, 60, 64, 67], [65, 69, 72, 76, 79]),
    C: (36, [55, 60, 62, 64], [64, 67, 72, 74, 79]),
    DM: (38, [57, 60, 62, 65], [62, 65, 69, 72, 77]),
    BB: (34, [58, 62, 65, 69], [62, 65, 70, 74, 77]),
}
# One chord to a bar, from the bar the name arrives on (4 seconds in).
BARS = {2: F, 3: F, 4: C, 5: DM, 6: BB, 7: F, 8: C, 9: DM, 10: BB, 11: C, 12: F, 13: F, 14: F}
bar_at = lambda bar: bar * BAR

dry = Mix()  # heard as it is
wet = Mix()  # sent to the room
plucked = Mix()  # sent to the echo, then a little to the room
low = Mix()  # bass and kick, kept out of the room
kicks = []

pile, brand, review, delete, end = (TIMELINE[k] for k in ("pile", "brand", "review", "delete", "end"))

# 1. The pile: a low held fifth, and a string plucked for every worktree,
# each higher than the last, closer and closer together.
wet.add(pad([38, 45, 50], pile["end"] - 0.2, bright=900, attack=1.6, release=0.25), 0.0, 0.3)
low.add(lowpass(np.sin(2 * np.pi * hz(38) * seconds(pile["end"])) * envelope(pile["end"], 1.8, 9, sustain=0.9, release=0.3), 160), 0, 0.09)
RISE = [62, 65, 67, 69, 72, 74, 77, 79, 81, 84, 86, 89, 91, 93, 96]
for i, at in enumerate(pile["chips"]):
    plucked.add(pluck(RISE[i], 0.8, bright=0.3 + i * 0.015), at, 0.42 + i * 0.006, pan=((i * 7) % 11 - 5) / 7)
    dry.add(tick(), at, 0.05, pan=((i * 5) % 9 - 4) / 6)
# Air drawn in toward the name...
wet.add(whoosh(pile["end"] - 2.3, 300, 9000, peak=0.96), 2.3, 0.3)
riser = seconds(pile["end"] - 2.6)
wet.add(np.sin(2 * np.pi * np.cumsum(hz(62) * 4 ** (riser / riser[-1])) / SR) * (riser / riser[-1]) ** 3 * 0.5, 2.6, 0.07)

# 2 and 6. The name: a deep note, a wide chord, and three bells going up.
MOTIF = [(0.0, 77), (0.125, 81), (0.25, 84), (0.75, 89)]
for arrival, strength in ((brand["start"], 1.0), (end["start"], 0.9)):
    t = seconds(1.4)
    low.add(np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-t / 0.09)) / SR) * np.exp(-t / 0.42), arrival, 0.5 * strength)
    wet.add(highpass(rng.uniform(-1, 1, int(1.6 * SR)), 5000) * np.exp(-seconds(1.6) / 0.45) * 0.5, arrival, 0.09 * strength)
    for offset, note in MOTIF:
        wet.add(bell(note, 2.6, shine=1.0), arrival + offset, 0.26 * strength, pan=(note - 83) / 12)
        dry.add(bell(note, 2.6, shine=1.0), arrival + offset, 0.19 * strength, pan=(note - 83) / 12)
    wet.add(keys(CHORDS[F][1] + [72], 3.0), arrival, 0.4 * strength)

# The chords, a bar each, from the name until it returns, where one chord is
# held to the end.
for bar, name in BARS.items():
    root, notes, _ = CHORDS[name]
    if bar > 12:
        continue
    if bar == 12:
        wet.add(pad(notes + [72], DURATION - end["start"] - 1.9, bright=2000, attack=0.02, release=1.9), bar_at(bar), 0.42)
        continue
    level = 0.42 if bar < 3 else 0.5 if bar < 9 else 0.58
    wet.add(pad(notes, BAR, bright=1600 if bar < 9 else 2300, attack=0.25 if bar >= 3 else 0.02, release=0.9), bar_at(bar), level)
    if 3 <= bar <= 11:
        dry.add(keys([n + 12 for n in notes], 1.5), bar_at(bar), 0.2)
        dry.add(keys([n + 12 for n in notes], 0.9), bar_at(bar) + 2.5 * BEAT, 0.12)

# The bass walks in with the window and stays under everything after.
for bar, name in BARS.items():
    if bar < 3:
        continue
    root = CHORDS[name][0]
    if bar >= 12:
        if bar == 12:
            # One last low note, left to die away with the chord above it.
            t = seconds(5.2)
            last = (np.sin(2 * np.pi * hz(root + 12) * t) + 0.3 * np.sin(2 * np.pi * hz(root + 24) * t)) * np.exp(-t / 1.5) * np.clip(t / 0.01, 0, 1)
            low.add(last, bar_at(bar), 0.3)
        continue
    busy = bar >= 9
    # Steps of a sixteenth: where the bass plays, and how long each note is.
    pattern = [(0, 3), (3, 1), (6, 2), (8, 3), (11, 1), (14, 2)] if busy else [(0, 4), (6, 2), (8, 4), (14, 2)]
    for step, steps in pattern:
        octave = 12 if step in (3, 11) else 0
        low.add(bass(root + 12 + octave, steps * BEAT / 4 * 0.92), bar_at(bar) + step * BEAT / 4, 0.25)

# The arpeggio: plucked sixteenths that arrive with the review and climb
# when the deletion starts.
for bar, name in BARS.items():
    if bar < 4 or bar > 11:
        continue
    tones = CHORDS[name][2]
    lifted = bar >= 9
    order = [0, 2, 1, 3, 2, 4, 3, 2, 0, 2, 1, 3, 4, 3, 2, 1] if lifted else [0, 2, 1, 3, 2, 1, 3, 2]
    step = BEAT / 4 if lifted else BEAT / 2
    quiet = 0.8 if bar < 6 else 0.7 if lifted else 1.0
    for i, tone in enumerate(order):
        accent = 1.0 if i % 4 == 0 else 0.72
        note = tones[tone] + (12 if lifted and i % 8 >= 4 else 0)
        plucked.add(pluck(note, 0.5, bright=0.3 + (0.25 if lifted else 0)), bar_at(bar) + i * step, 0.27 * accent * quiet, pan=0.55 * np.sin(i * 1.7))

# Drums: nothing until the window is in, then a little more every few bars.
for bar in range(3, 12):
    start = bar_at(bar)
    lifted = bar >= 9
    for beat in range(4):
        if lifted or beat in (0, 2):
            kicks.append(start + beat * BEAT)
            low.add(kick(1.0 if beat in (0, 2) else 0.8), start + beat * BEAT, 0.52)
    if bar >= 3 and not lifted:
        kicks.append(start + 2.75 * BEAT)
        low.add(kick(0.5), start + 2.75 * BEAT, 0.42)
    if bar >= 4:
        for beat in (1, 3):
            dry.add(snap(), start + beat * BEAT, 0.26 if bar < 9 else 0.3, pan=0.08)
            wet.add(snap(), start + beat * BEAT, 0.05)
    if bar >= 4:
        for eighth in range(8):
            if eighth % 2 == 1:
                dry.add(hat(open_=lifted), start + eighth * BEAT / 2, 0.12 if not lifted else 0.085, pan=-0.25)
            elif bar >= 6:
                dry.add(hat(0.03), start + eighth * BEAT / 2, 0.06, pan=0.25)
# A lift into the last bar before the name returns.
for i in range(8):
    dry.add(snap(), end["start"] - 1.0 + i * BEAT / 4, 0.05 + i * 0.022)
wet.add(whoosh(1.9, 500, 11000, peak=0.97), end["start"] - 1.9, 0.26)
kicks.append(end["start"])

# What happens on screen, heard: the pointer, the review opening, each
# worktree going, and the word that it is done.
for at in (review["click"], review["click2"]):
    dry.add(tick(), at, 0.5)
dry.add(blip(520, 780), review["click"] + 0.03, 0.12)
wet.add(whoosh(0.7, 900, 5000, peak=0.5), review["click"] - 0.05, 0.1)
wet.add(whoosh(1.2, 400, 7000, peak=0.75), TIMELINE["list"]["enter"] - 0.1, 0.2)
wet.add(whoosh(0.9, 700, 4200, peak=0.5), TIMELINE["list"]["states"] - 0.15, 0.1)
wet.add(whoosh(0.8, 3000, 500, peak=0.3), review["click2"], 0.12)
GONE = [72, 74, 77, 79, 81, 84, 86]
for i, at in enumerate(delete["done"]):
    plucked.add(bell(GONE[i], 0.9, shine=0.7), at, 0.16, pan=(i - 3) / 5)
    dry.add(blip(900 + i * 60, 500 + i * 30, 0.07), at, 0.07)
for offset, note in ((0.0, 81), (0.14, 86)):
    wet.add(bell(note, 1.6, shine=0.9), delete["toast"] + offset, 0.2)
    dry.add(bell(note, 1.6, shine=0.9), delete["toast"] + offset, 0.12)

# ------------------------------------------------------------------- mix --

# Everything but the drums ducks a little under each kick, and comes back.
duck = np.ones(N)
for at in kicks:
    start = int(at * SR)
    n = int(0.26 * SR)
    shape = 1 - 0.42 * np.exp(-np.arange(n) / SR / 0.075)
    duck[start : start + n] = np.minimum(duck[start : start + n], shape[: max(0, min(n, N - start))])

plucks = plucked.tape + echo(plucked.tape, BEAT * 0.75, feedback=0.38) * 0.55
room = reverb(wet.tape + plucks * 0.5 + dry.tape * 0.12)
music = (dry.tape + wet.tape * 0.72 + plucks + room * 0.5) * duck[:, None]
music = np.stack([highpass(music[:, c], 170) for c in (0, 1)], axis=1)
# A little more of the top, where small speakers can still be heard.
music = music + np.stack([highpass(music[:, c], 2800, order=1) for c in (0, 1)], axis=1) * 0.3
bottom = low.tape.copy()
bottom[:, :] = np.mean(bottom, axis=1, keepdims=True)  # the low end sits in the middle
track = music + np.stack([highpass(bottom[:, c], 28) for c in (0, 1)], axis=1)

# The whole thing: in from nothing, out to nothing, never past full scale.
track = track[: int(DURATION * SR)]
t = np.arange(len(track)) / SR
track *= np.clip(t / 0.15, 0, 1)[:, None]
track *= np.clip((DURATION - 0.02 - t) / (DURATION - end["fade"] + 0.35), 0, 1)[:, None] ** 1.4
track = np.stack([lowpass(track[:, c], 17000, order=4) for c in (0, 1)], axis=1)
peak = np.max(np.abs(track))
track = np.tanh(track / peak * 1.55) / np.tanh(1.55)  # the loudest moments are rounded, not clipped
track *= 0.84 / np.max(np.abs(track))

out = Path(sys.argv[1] if len(sys.argv) > 1 else "score.wav")
import wave

with wave.open(str(out), "wb") as file:
    file.setnchannels(2)
    file.setsampwidth(3)
    file.setframerate(SR)
    data = np.clip(track, -1, 1)
    # A little noise below hearing, so the quietest fade is not stepped.
    data = data + (rng.random(data.shape) - rng.random(data.shape)) / 2**23
    ints = (np.clip(data, -1, 1) * (2**23 - 1)).astype("<i4")
    file.writeframes(ints.astype("<i4").view(np.uint8).reshape(-1, 4)[:, :3].tobytes())

rms = lambda x: 20 * np.log10(np.sqrt(np.mean(x**2)) + 1e-12)
print(f"wrote {out}: {len(track) / SR:.2f}s, peak {20 * np.log10(np.max(np.abs(track))):.1f} dBFS, rms {rms(track):.1f} dBFS")
for a, b, name in ((0, 4, "pile"), (4, 6, "name"), (6, 12, "list"), (12, 18, "review"), (18, 24, "delete"), (24, 30, "end")):
    part = track[int(a * SR) : int(b * SR)]
    print(f"  {name:7s} {a:>2}-{b:<2}s  rms {rms(part):6.1f} dBFS  peak {20 * np.log10(np.max(np.abs(part)) + 1e-12):6.1f}")
