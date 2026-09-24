/**
 * HostRelay -- satisfies the engine's ProviderRegistry port by asking the host
 * agent, instead of by calling an API with a key.
 *
 * A plugin running inside Claude, Codex or Grok already sits on top of a
 * capable model the user is paying for. Demanding a second API key to reach a
 * *different* model would be absurd, so the relay turns "the engine needs a
 * completion" into "the tool result asks the host to produce one".
 *
 * How it works, and why it works this way:
 *
 *   The engine's LLM-using steps (`extractDelta`, `continuityCheck`, and the
 *   generation steps) all catch provider failures and degrade to their
 *   deterministic result. That is a gift: it means a first pass can run the
 *   whole step to completion with an empty relay, collecting every request the
 *   step wanted to make, without aborting halfway and leaving partial state.
 *
 *   So a relayed step runs in passes:
 *     pass 1 -- every `complete()` misses, is recorded, and throws. The step
 *               finishes with deterministic-only results.
 *     the host answers the recorded requests.
 *     pass 2 -- `complete()` hits the seeded answers and the step runs for
 *               real.
 *
 *   A pass can surface requests pass 1 never saw, if the step branches on a
 *   model answer. That is fine: run another pass. Answers accumulate, so it
 *   converges; `maxPasses` stops a pathological case.
 *
 * Request identity is `deriveRequestFingerprint` -- the same canonical hash the
 * engine's own replay-test infrastructure uses. Reusing it means an answer
 * keyed in pass 1 is guaranteed to be found in pass 2 for the same question,
 * and guaranteed *not* to be found if the question changed.
 */
import { deriveRequestFingerprint } from '../../engine/src/core/request-fingerprint.js';

export class PendingModelWork extends Error {
  constructor(key) {
    super(`vibelore: model work pending (${key.slice(0, 12)}…)`);
    this.name = 'PendingModelWork';
    this.key = key;
  }
}

/**
 * @param {Record<string,string>} answers  key -> completion text, from prior passes
 */
export function createHostRelay(answers = {}) {
  const seeded = new Map(Object.entries(answers));
  const pending = new Map();
  const shared = new Map();

  return {
    provenance: { kind: 'host-relay', contextIsolation: 'unverified' },
    /** Requests this pass wanted answered and could not. */
    get pending() {
      return [...pending.values()];
    },
    /** Material a workflow shares across independent requests, for the relay prompt layout. */
    get sharedContexts() {
      return [...shared.values()];
    },
    shareContext({ id, label, text }) {
      if (typeof text === 'string' && text.length > 0) shared.set(`${id}\u0000${text}`, { id, label, text });
    },
    register: () => undefined,
    has: () => true,
    async complete(req) {
      const key = deriveRequestFingerprint(req);
      const hit = seeded.get(key);
      if (hit !== undefined) return { text: hit };
      if (!pending.has(key)) {
        const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
        const user = req.messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
        const routed = req.model && req.model.modelId && req.model.modelId !== 'host-agent';
        pending.set(key, {
          id: key,
          step: req.step ?? 'unknown',
          jsonMode: req.jsonMode ?? false,
          ...(req.stage ? { stage: req.stage } : {}),
          ...(routed ? { model: { provider: req.model.provider, modelId: req.model.modelId } } : {}),
          ...(req.model?.reasoningEffort ? { reasoningEffort: req.model.reasoningEffort } : {}),
          system,
          user,
        });
      }
      throw new PendingModelWork(key);
    },
  };
}

const PREFLIGHT_TEXT = {
  worldbuild: '{"premise":"preflight","worldFacts":[]}',
  'cast-design': '{"characters":[]}',
  'entity-seed': '{"entities":[]}',
  'next-arc-proposal': '{"title":"preflight","promise":"preflight","type":"standard","estimatedEpisodes":12}',
  'era-research': '{"verdict":"uncertain","explanation":"preflight","sources":[]}',
  'arc-plan': '{"title":"preflight","promise":"preflight","type":"standard","episodes":[]}',
  'story-profile': '{"genreLabel":"preflight","engineGenre":"other","subgenres":[],"tones":[],"storyEngines":[],"themes":[],"format":{},"tracking":{},"promptGuidance":{}}',
  'episode-plan': '{"title":"preflight","premise":"preflight","scenes":[]}',
  'narrative-boundary': '{"decision":"advance_episode","reason":"preflight"}',
  'editorial-quality': '{"score":100,"dimensions":{"density":100,"endingFocus":100},"findings":[]}',
  'story-identity': '{"readerPromise":"주인공의 선택이 판을 바꾼다","protagonistAppeal":"결함 있는 유능함","competenceSignature":["오차를 수정한다"],"emotionalDefect":"사람을 수치로 본다","comedyEngines":["목적과 제도의 충돌"],"solutionPatternsToRotate":["환경 이용","정보전","아군 조합"]}',
  'pilot-contract': '{"beforeState":"잘못된 생존 방식을 믿는다","firstFailure":"그 믿음 때문에 실패한다","protagonistSpecificAction":"고유 능력으로 수정한다","irreversibleChoice":"되돌릴 수 없는 선택을 한다","competenceProof":"오차를 고친다","humanHook":"무엇을 선택할 것인가","seriesPromise":"선택으로 판을 바꾼다","closingQuestion":"대가를 감당할 수 있는가"}',
  'reader-hook': '{"score":100,"dimensions":{},"findings":[]}',
  'pattern-ledger': '{"solutionPattern":"","moralChoice":"","costShape":"","evidenceFamily":"","sceneMode":"","emotionalTemperature":"","endingImage":"","comedyMechanism":"","protagonistMethod":"","mistakeAndCorrection":"","supportingAgency":{}}',
  'arc-review': '{"score":100,"dimensions":{"payoffCadence":100,"patternVariety":100,"moralChoiceVariety":100,"emotionalTemperatureRange":100,"evidenceVariety":100,"endingVariety":100,"commercialMomentum":100},"findings":[]}',
  draft: '⟦vle:cast-manifest {"cast":[]}⟧',
  revise: '⟦vle:cast-manifest {"cast":[]}⟧',
  rewrite: '⟦vle:cast-manifest {"cast":[]}⟧',
};

/** Collect every prompt from throwing generation steps without persisting probe output. */
export function createPreflightRelay(answers = {}) {
  const base = createHostRelay(answers);
  return {
    provenance: base.provenance,
    get pending() { return base.pending; },
    get sharedContexts() { return base.sharedContexts; },
    shareContext: base.shareContext,
    register: base.register,
    has: base.has,
    async complete(req) {
      try { return await base.complete(req); }
      catch (err) {
        if (!(err instanceof PendingModelWork)) throw err;
        return { text: PREFLIGHT_TEXT[req.step] ?? '{}' };
      }
    },
  };
}

/**
 * Run `fn(relay)` in passes until nothing is pending.
 *
 * `ask` receives the outstanding requests and returns `{key: text}`. Returning
 * an empty object means "answer nothing" -- the loop stops and the caller gets
 * the deterministic-only result, which is a legitimate mode, not a failure.
 */
export async function runWithRelay(fn, ask, { answers = {}, maxPasses = 4 } = {}) {
  let acc = { ...answers };
  let result;
  let pending = [];
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const relay = createHostRelay(acc);
    result = await fn(relay);
    pending = relay.pending;
    if (pending.length === 0) return { result, answers: acc, pending: [], passes: pass + 1 };
    const replies = await ask(pending, pass);
    const added = Object.entries(replies ?? {}).filter(([, v]) => typeof v === 'string');
    if (added.length === 0) {
      return { result, answers: acc, pending, passes: pass + 1, degraded: true };
    }
    acc = { ...acc, ...Object.fromEntries(added) };
  }
  return { result, answers: acc, pending, passes: maxPasses, exhausted: true };
}
