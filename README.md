# Reelloom

Edit talking-head reels in your browser. Free, and your videos stay on your device.

**Status: early beta, open to everyone.** Works today: a multi-clip timeline (split, trim, move, delete, undo and redo, clip properties), one-click clean-up of silences, fillers, repeats and retakes, on-device captions in 7 styles with word highlight, transitions (fade, slide, crossfade), eased punch-in zoom, split explainer pages with a rounded picture-in-picture, a Shorts finder, one-click Autopilot (rule-based, on your device), projects saved in your browser, an optional AI helper that uses your own free key, loudness normalising and MP4 export.

- Site: https://reelloom.vercel.app
- Browsers: Chrome and Edge (WebCodecs, WebGPU). Safari and Firefox are partial.
- Beta: open to everyone, no sign-up. It is early, so tell us what breaks. Site and feedback: https://reelloom.vercel.app

## Principles
- Everything runs in the visitor's browser. No upload of video, ever.
- No API key is shipped in the page. AI runs on your own device by default. If AI helpers are added later they use your own free key; there is no shared key to run out.
- Only open-licence fonts and assets are included.

## Licence
MIT. See LICENSE.

## Third-party code (apps/web/app/vendor)
- mediabunny (MPL-2.0): video decode, encode and MP4 muxing in the browser.
- transformers.js (Apache-2.0) and onnxruntime-web (MIT): run the Whisper speech model on the device. The model files download from Hugging Face on first use.

### One file is not in git
`apps/web/app/vendor/transformers.js` (the unmodified transformers.js 4.3.2 build) is left out of the repo because GitHub push protection falsely flags a string inside it as a secret. To run the editor from a clone, fetch it once:

```
npm pack @huggingface/transformers@4.3.2 && tar -xzf huggingface-transformers-4.3.2.tgz package/dist/transformers.js && mv package/dist/transformers.js apps/web/app/vendor/
```
