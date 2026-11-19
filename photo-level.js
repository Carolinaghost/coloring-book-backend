'use strict';
// Straightens a tilted photo before it goes to the image model.
//
// The model copies how the head is held in the photo. Mei's sample photo has
// her head tilted about 21 degrees, and every page drawn from it - preview and
// paid - came back with the same tilt, whatever the prompt said. Rotating the
// photo so the eyes are level first fixed all six of her test pages (19 Nov
// 2026), at no cost in drawing time.
//
// How: find the face and its 68 landmark points (face-api, tiny models, run on
// the CPU through WebAssembly - no native build), take the angle of the line
// between the two eye centres, and rotate the photo by the opposite amount.
// Measured on the four sample photos: 110-250 ms a photo.
//
// It only acts when it is sure it is looking at one face:
//   - exactly one face found (a group photo has several heads at several
//     angles, and turning the whole picture for one of them is a guess)
//   - the tilt is between MIN_DEG and MAX_DEG (under that is noise; over it
//     is a child lying down, or a bad read, and either way not a tilt)
// Anything else - no face, two faces, an error - returns the photo untouched.
// A photo that is left alone is drawn exactly as before this existed.
//
// PHOTO_LEVEL=off on Render turns it off without a deploy.

const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const ENABLED = process.env.PHOTO_LEVEL !== 'off';
const MIN_DEG = 4;
const MAX_DEG = 35;
const DETECT_SIZE = 512;

let faceapi = null;
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      require('@tensorflow/tfjs');
      require('@tensorflow/tfjs-backend-wasm');
      faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
      await faceapi.tf.setBackend('wasm');
      await faceapi.tf.ready();
      const models = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');
      await faceapi.nets.tinyFaceDetector.loadFromDisk(models);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(models);
    })();
    // A failed start is not cached: the next photo tries again.
    ready.catch(() => { ready = null; });
  }
  return ready;
}

const centre = (pts) => pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });

// The tilt of the one face in the photo, in degrees, or null when there is not
// exactly one face. Positive means the line from the left eye to the right eye
// (as seen in the picture) runs downhill.
async function eyeTilt(buffer) {
  await init();
  const { data, info } = await sharp(buffer).rotate()
    .resize(DETECT_SIZE, DETECT_SIZE, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const input = faceapi.tf.tensor3d(data, [info.height, info.width, 3], 'int32');
  try {
    const faces = await faceapi.detectAllFaces(input,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 })).withFaceLandmarks();
    if (faces.length !== 1) return { tilt: null, faces: faces.length };
    const left = centre(faces[0].landmarks.getLeftEye());
    const right = centre(faces[0].landmarks.getRightEye());
    return { tilt: Math.atan2(right.y - left.y, right.x - left.x) * 180 / Math.PI, faces: 1 };
  } finally {
    input.dispose();
  }
}

// Rotate so the eyes are level, keeping the photo's own size: the corners the
// turn exposes are filled with a soft grey, and only the face matters to the
// model anyway.
async function rotateLevel(buffer, tilt) {
  // Turn the phone's EXIF orientation into real pixels first, so the size
  // below is the size the picture actually shows at.
  const oriented = await sharp(buffer).rotate().toBuffer({ resolveWithObject: true });
  const { width, height } = oriented.info;
  const turned = await sharp(oriented.data).rotate(-tilt, { background: { r: 235, g: 235, b: 235 } })
    .toBuffer({ resolveWithObject: true });
  const left = Math.max(0, Math.round((turned.info.width - width) / 2));
  const top = Math.max(0, Math.round((turned.info.height - height) / 2));
  return sharp(turned.data)
    .extract({ left, top, width: Math.min(width, turned.info.width), height: Math.min(height, turned.info.height) })
    .jpeg({ quality: 92 }).toBuffer();
}

// Small memory of photos already looked at: a paid book draws fifteen pages
// from the same photo, and the answer does not change between them.
const seen = new Map();
const SEEN_MAX = 64;

// The promise is remembered, not the answer, so the four style tiles that start
// at the same moment share one look at the photo instead of making four.
function levelPhoto(ref) {
  if (!ENABLED || !ref || !ref.buffer) return Promise.resolve(ref);
  const key = crypto.createHash('sha1').update(ref.buffer).digest('hex');
  if (!seen.has(key)) {
    if (seen.size >= SEEN_MAX) seen.delete(seen.keys().next().value);
    seen.set(key, (async () => {
      try {
        const { tilt } = await eyeTilt(ref.buffer);
        if (tilt === null || Math.abs(tilt) < MIN_DEG || Math.abs(tilt) > MAX_DEG) return null;
        return { buffer: await rotateLevel(ref.buffer, tilt), tilt };
      } catch (err) {
        console.error('Could not check the photo for a tilt, drawing it as it is -', err.message);
        return null;
      }
    })());
  }
  return seen.get(key).then((done) => (done
    ? { ...ref, buffer: done.buffer, mimetype: 'image/jpeg',
      filename: (ref.filename || 'photo').replace(/\.[a-z0-9]+$/i, '') + '.jpg', levelledBy: done.tilt }
    : ref));
}

module.exports = { levelPhoto, eyeTilt, rotateLevel, init, ENABLED, MIN_DEG, MAX_DEG };
