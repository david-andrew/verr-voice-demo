// MusicXML per-minute is printed text, unlike the numeric sound/@tempo.
// Unrecognized text (including metric modulations) keeps the previous tempo.
export function metronomeRate(value) {
  const number = String.raw`[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)`;
  const match = new RegExp(
    String.raw`^\s*(?:(?:circa|ca|c|approximately|approx|about)\.?\s*|[≈~]\s*)?(${number})(?:\s*[-–—]\s*(${number}))?\s*(?:bpm)?\s*$`,
    "i",
  ).exec(value || "");
  if (!match) return null;
  return match[2] ? (Number(match[1]) + Number(match[2])) / 2 : Number(match[1]);
}
