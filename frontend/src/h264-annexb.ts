// Small, dependency-free Annex-B H.264 helpers for DevicePane.tsx's
// WebCodecs decode path. Scrcpy's video stream (via @yume-chan/adb-scrcpy on
// the backend, relayed raw over /ws/device/:deviceId — see that route's own
// wire-framing comment) is Annex-B: NAL units delimited by start codes
// (00 00 01 or 00 00 00 01), not length-prefixed AVCC. WebCodecs' own
// VideoDecoder can consume Annex-B directly via `avc: { format: "annexb" }`
// in its config, but that config also needs an exact `codec` string
// (`avc1.PPCCLL` — profile_idc/constraint_flags/level_idc as hex), which
// isn't knowable in advance: it has to be read out of the stream's own SPS
// NAL unit, delivered once as the "configuration" packet
// (routes/device.ts's wire framing, type 0) before any video data arrives.
//
// This logic is pure and independently unit-tested (h264-annexb.test.ts)
// specifically because DevicePane.tsx's actual decode path could not be
// exercised against a live device in the environment this shipped from — see
// that PR's own description. Getting the codec string wrong here fails
// VideoDecoder.configure() loudly (an error event), not silently.

/** One NAL unit found in an Annex-B byte stream: `type` is the 5-bit
 * `nal_unit_type` field (7 = SPS, 8 = PPS for H.264), `payload` is the NAL
 * unit's bytes AFTER its 1-byte header, up to (not including) the next
 * start code. */
export interface AnnexBNalUnit {
  type: number;
  payload: Uint8Array;
}

/** Finds every start-code offset (`00 00 01` or `00 00 00 01`) in `data`,
 * returning the offset of the byte immediately AFTER each start code (i.e.
 * where that NAL unit's own header byte begins). */
function findStartCodeOffsets(data: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      offsets.push(i + 3);
      i += 2;
    }
  }
  return offsets;
}

/** Splits an Annex-B byte stream into its constituent NAL units. A 4-byte
 * start code (`00 00 00 01`) is indistinguishable from a 3-byte one
 * followed by a leading zero byte still belonging to the NAL — both forms
 * are handled identically here since findStartCodeOffsets always anchors on
 * the 3-byte `00 00 01` suffix, which every 4-byte start code also
 * contains. */
export function splitAnnexBNalUnits(data: Uint8Array): AnnexBNalUnit[] {
  const offsets = findStartCodeOffsets(data);
  const units: AnnexBNalUnit[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    if (start >= data.length) continue;
    // The next NAL's start code begins 3 or 4 bytes before the next
    // offset's own "after start code" position — trim any trailing zero
    // byte(s) belonging to the FOLLOWING NAL's 4-byte start code, not this
    // NAL's own payload.
    let end = i + 1 < offsets.length ? offsets[i + 1] - 3 : data.length;
    while (end > start && data[end - 1] === 0) end--;
    if (end <= start) continue;
    units.push({ type: data[start] & 0x1f, payload: data.subarray(start + 1, end) });
  }
  return units;
}

function toHexByte(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/** Derives the WebCodecs `avc1.PPCCLL` codec string from a raw SPS NAL
 * unit's payload (the bytes after the NAL header byte, before any
 * exp-golomb-coded fields) — `profile_idc`, `constraint_flags`, and
 * `level_idc` are always the first three bytes of an H.264 SPS, in that
 * fixed order, regardless of profile. Returns `null` if `spsPayload` is too
 * short to contain them (a malformed/truncated SPS). */
export function deriveAvcCodecString(spsPayload: Uint8Array): string | null {
  if (spsPayload.length < 3) return null;
  const [profileIdc, constraintFlags, levelIdc] = spsPayload;
  return `avc1.${toHexByte(profileIdc)}${toHexByte(constraintFlags)}${toHexByte(levelIdc)}`;
}

/** Finds the first SPS NAL unit's payload and derives its codec string in
 * one step — the shape DevicePane.tsx actually wants when it receives the
 * "configuration" packet (which always carries SPS + PPS together). `null`
 * if no NAL of type 7 (SPS) is present at all. */
export function deriveAvcCodecStringFromConfig(configData: Uint8Array): string | null {
  const sps = splitAnnexBNalUnits(configData).find((nal) => nal.type === 7);
  return sps ? deriveAvcCodecString(sps.payload) : null;
}
