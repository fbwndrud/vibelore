import { createHash } from 'node:crypto';
import { deriveRequestFingerprint } from '../../engine/src/core/request-fingerprint.js';

const hash = (value) => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
const score = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const REQUIRED_DIMENSIONS = {
  'character-fidelity': ['voice', 'motivation', 'responseCausality', 'relationshipContinuity', 'dialogueIntent'],
  'arc-review': ['payoffCadence', 'patternVariety', 'moralChoiceVariety', 'emotionalTemperatureRange', 'evidenceVariety', 'endingVariety', 'commercialMomentum'],
};
const parse = (value) => {
  try { return JSON.parse(String(value).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); }
  catch { return null; }
};

/** One review attempt: retain evidence independently of publication policy. */
export function createReviewAudit({ providers, prose, chapter, contractDigest, saveExchange, timeoutMs = 45000 }) {
  const records = [];
  const binding = { chapter, proseHash: hash(prose), contractDigest };
  const auditedProvider = {
    get pending() { return providers.pending ?? []; },
    async complete(request) {
      const boundRequest = { ...request, messages: [...request.messages,
        { role: 'user', content: `검토 대상 식별: ${JSON.stringify(binding)}\n현재 요청의 본문을 읽고 근거를 확인한 뒤 이 요청에 답한다. 점수는 독자 만족도나 평가 문맥의 독립성을 증명하지 않는다.` },
      ] };
      const record = { step: request.step, ...binding,
        requestId: deriveRequestFingerprint(boundRequest),
        evaluator: providers.provenance ?? { kind: 'unknown', contextIsolation: 'unverified' },
        requestedModel: request.model, status: 'failed', findings: [] };
      let timer;
      let response;
      try {
        response = await Promise.race([
          providers.complete(boundRequest),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Review timeout'), { code: 'REVIEW_TIMEOUT' })), timeoutMs); }),
        ]);
        if ((providers.pending?.length ?? 0) > 0) return response;
        const raw = String(response?.text ?? '');
        const parsed = parse(raw);
        record.responseHash = hash(raw);
        record.findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
        const valid = parsed && !Array.isArray(parsed) && (request.step === 'pattern-ledger'
          ? typeof parsed.solutionPattern === 'string' && parsed.solutionPattern.trim().length > 0
          : score(parsed.score) && (request.step === 'coherence-judge' || Array.isArray(parsed.findings)))
          && (REQUIRED_DIMENSIONS[request.step] ?? []).every((key) => score(parsed?.dimensions?.[key]));
        record.status = valid ? 'completed' : 'failed';
        if (!valid) record.failure = 'INVALID_REVIEW_RESPONSE';
        record.exchangeId = await saveExchange({ request: boundRequest, response: raw, binding });
        records.push(record);
        // A failed response must not become a default good score downstream.
        return valid ? response : { text: '{}' };
      } catch (error) {
        if ((providers.pending?.length ?? 0) === 0) {
          record.status = 'failed';
          record.failure = error.code === 'REVIEW_TIMEOUT' ? 'REVIEW_TIMEOUT' : 'REVIEW_PROVIDER_FAILED';
          if (!records.includes(record)) records.push(record);
          record.exchangeId = await saveExchange({ request: boundRequest, response: null, failure: record.failure, binding });
        }
        throw error;
      } finally { clearTimeout(timer); }
    },
  };
  return {
    providers: auditedProvider,
    async run(step, action, fallback) {
      try {
        const result = await action(auditedProvider);
        if ((providers.pending?.length ?? 0) === 0 && result !== null) {
          const valid = step === 'pattern-ledger' ? Boolean(result?.solutionPattern) : score(result?.score);
          const record = records.findLast((item) => item.step === step);
          if (!valid && record?.status === 'completed') Object.assign(record, { status: 'failed', failure: 'INCOMPLETE_REVIEW_RESULT' });
        }
        return result;
      } catch {
        // Pending requests are resumed by the caller; actual failures are kept
        // in records and suppress auto publication without destroying the prose.
        if ((providers.pending?.length ?? 0) === 0) {
          const record = records.findLast((item) => item.step === step);
          if (record?.status === 'completed') Object.assign(record, { status: 'failed', failure: 'REVIEW_EXECUTION_FAILED' });
          else if (!record) records.push({ step, ...binding, status: 'failed', failure: 'REVIEW_EXECUTION_FAILED', findings: [] });
        }
        return structuredClone(fallback);
      }
    },
    result() {
      return { schemaVersion: 1, ...binding, status: records.length && records.every((item) => item.status === 'completed') ? 'completed' : 'failed', records };
    },
  };
}

export function reviewFindingAdvisories(review, chapterNumber) {
  return review.records.flatMap((record) => record.findings.flatMap((finding) => {
    if (typeof finding?.message !== 'string' || !finding.message.trim()) return [];
    return [{ ...finding, severity: 'soft', advisoryOnly: true, chapterNumber,
      code: typeof finding.code === 'string' ? finding.code : 'REVIEW_FINDING',
      reviewStep: record.step, requestId: record.requestId,
    }];
  }));
}
