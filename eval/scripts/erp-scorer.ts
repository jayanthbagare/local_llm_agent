// ── ERP throughput-accounting benchmark scorer ──
// Similar normalization rules to the GAIA scorer (eval/scripts/gaia-scorer.ts)
// but type-aware: our tasks have a known `answer_type` (number | id | yes_no)
// instead of GAIA's "guess the shape from the ground truth string" approach,
// since we generated the tasks ourselves.

export type AnswerType = 'number' | 'id' | 'yes_no';

function normalizeNumberStr(numberStr: string): number {
  let s = numberStr.trim();
  for (const ch of ['$', '%', ',']) s = s.split(ch).join('');
  const n = Number(s);
  return Number.isNaN(n) ? NaN : n;
}

/** Pull the first number-looking token out of free text (e.g. "The answer is $4,160."). */
function extractFirstNumber(text: string): number {
  const match = text.match(/-?\$?\d[\d,]*(\.\d+)?/);
  if (!match) return NaN;
  return normalizeNumberStr(match[0]);
}

const PUNCT_RE = /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/g;

function normalizeStr(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(PUNCT_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Scores a single predicted answer against the expected answer for a given answer type. */
export function scoreAnswer(predicted: string, expected: string, answerType: AnswerType): boolean {
  const pred = predicted ?? '';
  const exp = expected ?? '';

  if (answerType === 'number') {
    const predNum = extractFirstNumber(pred);
    const expNum = normalizeNumberStr(exp);
    if (Number.isNaN(predNum) || Number.isNaN(expNum)) return false;
    return predNum === expNum;
  }

  if (answerType === 'yes_no') {
    const npred = normalizeStr(pred);
    const nexp = normalizeStr(exp);
    const predYes = /^(yes|y|true)/.test(npred);
    const predNo = /^(no|n|false)/.test(npred);
    const expYes = nexp === 'yes';
    if (expYes) return predYes;
    return predNo;
  }

  // 'id' — product / work-center name. Accept exact normalized match, or the
  // expected name appearing as a whole word/phrase within the prediction
  // (models sometimes answer in a full sentence despite instructions).
  const npred = normalizeStr(pred);
  const nexp = normalizeStr(exp);
  if (npred === nexp) return true;
  if (npred.length > 0 && nexp.length > 0) {
    const re = new RegExp(`(^|\\s)${nexp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
    if (re.test(npred)) return true;
  }
  return false;
}
