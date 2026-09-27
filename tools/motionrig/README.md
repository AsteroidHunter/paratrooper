# Motion rig

Plays the phone app through its motions on an emulated iPhone and measures every frame.

Run it from the repository root, with the web extra and Playwright's Chromium installed in the venv:

```
.venv/bin/python tools/motionrig/rig.py --runs 3 --label before --out /tmp/motionrig
.venv/bin/python tools/motionrig/rig.py compare /tmp/motionrig/before.json /tmp/motionrig/after.json
```

It builds `pwa/dist` unminified with a source map, and starts its own copy of the web service on a free local port (`server.py`). That copy has a seeded thread of 400 messages with photos, and a scripted stand-in for the worker. It then drives headless Chromium: iPhone 15 Pro screen, touch, 4x CPU slowdown.

The flows are:

- a cold open
- peeking at the times
- the keyboard up and down
- typing until the bar grows
- a send, and the reply with its dots
- attaching and sending a photo
- flinging back through history until older pages load
- the peek again, a few hundred rows deep
- the jump chevron
- a reply in the deep thread
- a return from the background

Each flow reports:

- frames over 16.7 ms and the longest frame
- the compositor's dropped and partial frames
- long tasks
- style and layout passes, with the forced ones named by function and `pwa/src` line

Options:

- `--shots` saves JPEGs of the key moments.
- `--traces` keeps each flow's trace, which you can open in the DevTools Performance panel.
- `--attribute` adds a pass that wraps the layout APIs and takes a CPU profile. Use it to name the culprits, not to score.
- `--css FILE` lays a stylesheet over the app, so you can try a CSS change without a rebuild.
- `--no-build` measures whatever is already in `pwa/dist`.

The numbers compare one build with another. They do not predict an iPhone:

- Chrome's slowdown applies to the main thread only.
- Headless Chrome ticks at 60 Hz from a timer.
