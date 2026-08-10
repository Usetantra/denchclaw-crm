'use strict';
// ─── SMS encoding + segment calculator ────────────────────────────────────────
// Determines whether a message fits GSM-7 (7-bit) or must use UCS-2 (Unicode),
// and how many concatenated segments it costs. Any character outside the GSM 03.38
// set (emoji, non-Latin script, most accents) forces the WHOLE message to UCS-2.
// Limits: GSM-7 160/segment (153 when concatenated); UCS-2 70/segment (67 when
// concatenated). GSM-7 "extended" characters occupy two code units each.
// Pure + deterministic — no I/O, unit-testable without any provider.

// GSM 03.38 basic character set (each = 1 unit).
const GSM7_BASIC = new Set(
  ('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
   '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà')
    .split('')
);
// GSM 03.38 extended set (each = 2 units, sent via an escape prefix).
const GSM7_EXTENDED = new Set(['\f', '^', '{', '}', '\\', '[', '~', ']', '|', '€']);

function isGsm7(text) {
  for (const ch of text) {
    if (!GSM7_BASIC.has(ch) && !GSM7_EXTENDED.has(ch)) return false;
  }
  return true;
}

// Count GSM-7 code units (extended chars count as 2).
function gsm7Units(text) {
  let n = 0;
  for (const ch of text) n += GSM7_EXTENDED.has(ch) ? 2 : 1;
  return n;
}

// UCS-2 units = number of UTF-16 code units (so astral chars / most emoji = 2).
function ucs2Units(text) {
  return text.length; // JS strings are UTF-16; .length is the code-unit count
}

// Returns { encoding, chars, units, segments, perSegment, remaining }.
function analyze(text) {
  const t = String(text == null ? '' : text);
  const gsm = isGsm7(t);
  const encoding = gsm ? 'GSM-7' : 'UCS-2';
  const units = gsm ? gsm7Units(t) : ucs2Units(t);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;

  let segments, perSegment;
  if (units === 0) { segments = 0; perSegment = single; }
  else if (units <= single) { segments = 1; perSegment = single; }
  else { segments = Math.ceil(units / multi); perSegment = multi; }

  const remaining = segments <= 1 ? single - units : segments * perSegment - units;
  // Count visible characters (astral chars as 1) for display.
  const chars = [...t].length;
  return { encoding, chars, units, segments, perSegment, remaining };
}

module.exports = { analyze, isGsm7 };
