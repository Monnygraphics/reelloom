# Video Studio

Edit talking-head reels in your browser. Free, and your videos stay on your device.

**Status: early beta.** This repo currently holds the landing page. The browser editor is being built in the open, in this order: manual editor, export, on-device AI, then optional AI helpers.

- Site: https://videostudio-rust.vercel.app
- Browsers: Chrome and Edge (WebCodecs, WebGPU). Safari and Firefox are partial.
- Beta: the first 50 testers get access. Register and send feedback at https://videostudio-rust.vercel.app

## Principles
- Everything runs in the visitor's browser. No upload of video, ever.
- No API key is shipped in the page. Optional AI uses your own key, or a capped invite-only proxy.
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
