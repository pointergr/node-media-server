import assert from "assert";
import { createRequire } from "module";
import { patchAvc1 } from "./ertmp.js";

const Flv = createRequire(import.meta.url)("node-media-server/src/protocol/flv.js");
const VIDEO = 9;

// byte0 = isExHeader<<7 | frameType<<4 | packetType, μετά ο fourCC
const tag = (frameType, packetType, fourCC, rest = []) =>
  Buffer.concat([Buffer.from([0x80 | (frameType << 4) | packetType]), Buffer.from(fourCC), Buffer.from(rest)]);

// Πριν το patch: το avc1 δεν το πιάνει κανένας κλάδος και μένει «audio header»
const before = Flv.parserTag(VIDEO, 0, 5, tag(1, 0, "avc1"));
assert.strictEqual(before.flags, 0, "το upstream bug υπάρχει ακόμα — ίσως διορθώθηκε το nms");

patchAvc1();

const seq = Flv.parserTag(VIDEO, 0, 5, tag(1, 0, "avc1"));
assert.strictEqual(seq.flags, 2, "sequence start -> video header");
assert.strictEqual(seq.codec_id, 0x61766331);

const key = Flv.parserTag(VIDEO, 100, 8, tag(1, 1, "avc1", [0, 0, 40]));
assert.strictEqual(key.flags, 3, "keyframe -> νέο gop");
assert.strictEqual(key.pts, 140, "CodedFrames: pts = dts + cts");

const inter = Flv.parserTag(VIDEO, 100, 8, tag(2, 1, "avc1", [0, 0, 0]));
assert.strictEqual(inter.flags, 4, "inter frame");

const interX = Flv.parserTag(VIDEO, 100, 5, tag(2, 3, "avc1"));
assert.strictEqual(interX.flags, 4);
assert.strictEqual(interX.pts, 100, "CodedFramesX: χωρίς cts");

// Ό,τι δεν είναι avc1 μένει όπως το βρήκαμε
const hevc = Flv.parserTag(VIDEO, 0, 5, tag(1, 0, "hvc1"));
assert.strictEqual(hevc.flags, 2);
const legacy = Flv.parserTag(VIDEO, 0, 6, Buffer.from([0x17, 0x00, 0, 0, 0, 0]));
assert.strictEqual(legacy.flags, 2, "legacy AVC sequence header");

console.log("test-ertmp OK");
