// Enhanced RTMP με fourCC "avc1" — αυτό στέλνει το OBS όταν ο server δηλώνει
// E-RTMP στο connect. Το node-media-server 4.2.8 αναγνωρίζει μόνο av01/vp09/hvc1
// (flv.js:264): για το avc1 δεν τρέχει κανένας κλάδος και το πακέτο μένει με το
// default flags=0, δηλαδή «audio sequence header». Συνέπεια στο broadcast_server:
// το avcC δεν μπαίνει ποτέ στο rtmpVideoHeader και το gop cache μένει άδειο, οπότε
// όποιος συνδεθεί *μετά* τον publisher δεν παίρνει ποτέ SPS/PPS. Ο ffmpeg του HLS
// συνδέεται ~200ms μετά το postPublish (κόστος spawn), χάνει την κούρσα με το
// πρώτο keyframe του OBS και γεμίζει τα logs με "startcode missing" /
// "non-existing PPS" — και τα segments βγαίνουν χωρίς εικόνα.
import { createRequire } from "module";

const Flv = createRequire(import.meta.url)("node-media-server/src/protocol/flv.js");

const FLV_MEDIA_TYPE_VIDEO = 9;
const FOURCC_AVC = Buffer.from("avc1");

export function patchAvc1() {
  const parserTag = Flv.parserTag;
  Flv.parserTag = (type, time, size, data) => {
    const packet = parserTag(type, time, size, data);
    if (type !== FLV_MEDIA_TYPE_VIDEO) return packet;
    const isExHeader = (data[0] & 0x80) !== 0;
    if (!isExHeader || data.subarray(1, 5).compare(FOURCC_AVC) !== 0) return packet;

    const packetType = data[0] & 0x0f;
    const isKey = (data[0] >> 4 & 0b0111) === 1;
    packet.codec_id = data.readUint32BE(1);
    if (packetType === 0) {
      packet.flags = 2; // SequenceStart — το avcC
    } else if (packetType === 1 || packetType === 3) {
      packet.flags = isKey ? 3 : 4;
      // CodedFrames (όχι το X) κουβαλάει 3 bytes composition time offset
      if (packetType === 1) packet.pts = packet.dts + data.readUintBE(5, 3);
    }
    return packet;
  };
}
