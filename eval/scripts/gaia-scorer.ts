// ── GAIA answer scorer ──
// Ported from the official GAIA scoring function used by smolagents /
// the HF leaderboard (huggingface/smolagents examples/open_deep_research
// /scripts/gaia_scorer.py), so results are comparable to published scores.
//
// Exact-match after normalization:
//  - numeric ground truth  -> strip $/%/commas, compare as float
//  - list ground truth (has , or ;) -> split + compare element-wise
//  - string ground truth   -> lowercase, strip whitespace + punctuation

function isFloat(value: string): boolean {
  if (value.trim() === '') return false;
  return !Number.isNaN(Number(value));
}

function normalizeNumberStr(numberStr: string): number {
  let s = numberStr;
  for (const ch of ['$', '%', ',']) s = s.split(ch).join('');
  const n = Number(s);
  return Number.isNaN(n) ? Infinity : n;
}

function splitString(s: string): string[] {
  return s.split(/[,;]/);
}

const PUNCT_RE = /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/g;

function normalizeStr(input: string, removePunct = true): string {
  const noSpaces = input.replace(/\s/g, '');
  if (removePunct) {
    return noSpaces.toLowerCase().replace(PUNCT_RE, '');
  }
  return noSpaces.toLowerCase();
}

/** Exact GAIA scoring rule: returns true iff modelAnswer exactly matches groundTruth. */
export function questionScorer(modelAnswer: string, groundTruth: string): boolean {
  const ma = modelAnswer ?? '';
  const gt = groundTruth ?? '';

  if (isFloat(gt)) {
    return normalizeNumberStr(ma) === Number(gt);
  }

  if (gt.includes(',') || gt.includes(';')) {
    const gtElems = splitString(gt);
    const maElems = splitString(ma);
    if (gtElems.length !== maElems.length) return false;
    return gtElems.every((gtElem, i) => {
      const maElem = maElems[i];
      if (isFloat(gtElem)) {
        return normalizeNumberStr(maElem) === Number(gtElem);
      }
      return normalizeStr(maElem, false) === normalizeStr(gtElem, false);
    });
  }

  return normalizeStr(ma) === normalizeStr(gt);
}

/**
 * Looser "close call" check GAIA also reports (letters of the true answer
 * appear in order within a similarly-sized prediction). Only meaningful for
 * non-numeric ground truths. Returns the strict result unless it's a near miss.
 */
export function checkCloseCall(prediction: string, trueAnswer: string, isCorrect: boolean): boolean {
  if (isCorrect) return true;
  if (isFloat(trueAnswer)) return isCorrect;

  const pred = String(prediction).toLowerCase();
  const truth = String(trueAnswer).toLowerCase();
  if (pred.length > truth.length * 3) return false;

  let i = 0;
  for (const letter of truth) {
    const idx = pred.slice(i).indexOf(letter);
    if (idx === -1) return false;
    i += idx;
  }
  return pred.length >= truth.length * 0.5 && pred.length <= truth.length * 2;
}
