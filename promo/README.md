# The promotional video

A thirty-second film about Arbor, made entirely from this folder: there is no
footage, no recorded sound, and no real data in it.

- **The application on screen is the real one.** `composition/` is a web page
  with the desktop window's own code running in a frame. `mock-preload.cjs`
  stands in for its backend, and `data.cjs` is the invented workspace it is
  shown: every repository, branch, path, size and date is made up, and
  nothing is read from a disk. The buttons are really pressed.
- **The picture is drawn one frame at a time.** `render.cjs` asks the page to
  show itself at each sixtieth of a second and hands the pictures to ffmpeg.
  Nothing runs by the clock, so a slow machine draws the same film as a fast
  one. Frames are drawn at twice the size and reduced.
- **The soundtrack is arithmetic.** `score.py` synthesizes every sound: no
  samples, nothing to license. It reads `composition/timeline.js`, as the
  picture does, so a click seen and a click heard are the same moment.

## The script

Thirty seconds, six scenes, no voice: the words are on the screen. The music
is at 120 beats a minute, so every scene starts on a bar.

| Time | What is seen | Words on screen | What is heard |
| --- | --- | --- | --- |
| 0:00 | Fifteen worktrees appear around the frame, one after another, faster and faster, while a count climbs to 40.5 GB. | **Another branch. Another worktree.** then **They pile up.** | A low held fifth. A string plucked for each worktree, each higher and sooner than the last. Air drawn in. |
| 0:04 | Everything is pulled to one place and becomes the mark: the tile lands, the trunk is drawn, the leaves open, the name comes out from behind it. | **Arbor** · Git worktrees, under control. | A deep note, a wide chord, three bells going up. |
| 0:06 | The application rises into view beside the words, and the camera comes slowly closer. | SEE · **Every worktree, in one place.** On this computer and over SSH. | The beat arrives: bass and keys. |
| 0:09 | Close on the list, and still. A worktree holding uncommitted work is outlined in amber, then two merged ones in green. | UNDERSTAND · **Find finished work.** Unfinished work is left alone. | Hats and finger snaps join. |
| 0:12 | The camera draws back to hold the whole window; the pointer goes to **Delete recommended** and presses it. | | A click. |
| 0:13 | The review opens and takes the width of the stage. The reason under the first worktree is underlined, and held for two seconds. Then one move to the foot of the list: the total, and **Delete 7 worktrees**, which the pointer presses. | REVIEW · **Review before you delete.** | A plucked arpeggio over the same chords. |
| 0:18 | Back beside the words. Progress, files counted, and the worktrees leave the list one at a time, on the beat, while the estimate climbs to 18.4 GB. The notification that it is done. | PRUNE · **Then it's gone.** Branches and commits kept. · 18.4 GB estimated space recovered | The lift: a kick on every beat, a bell for each worktree gone, a chime when all are. |
| 0:24 | The application falls away and the name returns, with where to find it. | **Arbor** (Alpha) · Clean up Git worktrees. Keep your branches. · macOS · Linux · SSH hosts · Free and open source · github.com/stbenjam/arbor | The opening chord and bells again, held, and out. |

A line at the foot of the frame says, for as long as the application is on
screen, that it is the real application on an invented workspace. The files
it is seen deleting are the kind a repository tracks, since the worktrees it
recommends have nothing ignored in them.

## Building it

```sh
promo/build.sh           # writes ~/.cache/arbor-promo/out/arbor-promo.mp4
promo/build.sh film.mp4  # or wherever you say
```

It needs `node`, `npm`, `python3`, `curl`, and on Linux `xvfb-run`. The first
run downloads an ffmpeg that can write H.264 and two typefaces, Inter and
JetBrains Mono, both under the SIL Open Font License; they go in the cache
folder and are not installed on the system. A build takes about ten minutes.

To look at single moments while changing something:

```sh
electron promo/render.cjs --stills 4.5,12.9,26 --out /some/folder
```

## Changing it

- `composition/timeline.js` says when everything happens, in seconds. The
  music is at 120 beats a minute, so half seconds are beats and even seconds
  are bars; cuts sit on them.
- `composition/comp.js` is the film: what is where at time `t`.
- `data.cjs` is what the application is shown.
