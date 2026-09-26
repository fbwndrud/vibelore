import { renderStoryProfile } from '../tools/story-profile.js';
import { renderArcBeat } from './prompt-sections.js';

const asArray = (value) => Array.isArray(value) ? value : [];
const text = (value) => typeof value === 'string' ? value.trim() : '';

/**
 * Inputs of the StoryProfile drift check as text. The check judges tone,
 * engine and beat drift, so it gets the rendered profile (with the user's
 * settled decisions), the fixed arc beat, who is on stage, and what the plan
 * deliberately withheld or deferred — so a deferred payoff is not flagged as
 * drift. The whole plan is the coherence review's input, not this one's.
 */
// Profiles saved before the v2 shape miss fields renderStoryProfile expects;
// the check then sees the fields that are there.
function profileText(profile, kit) {
  try {
    const rendered = renderStoryProfile(profile, kit);
    if (rendered) return rendered;
  } catch { /* fall through to the plain fields */ }
  return Object.entries(profile ?? {})
    .filter(([key, value]) => !['status', 'revision', 'workId', 'createdAt', 'updatedAt', 'language'].includes(key)
      && (typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'))))
    .map(([key, value]) => `- ${key}: ${[].concat(value).join(', ')}`)
    .join('\n');
}

export function profileCheckInputs({ profile, arcEpisode, episodePlan, foundation, prose, kit }) {
  const t = kit.phrases.sections;
  const settled = asArray(profile?.designReview?.settledDecisions).map((item) => text(item?.decision ?? item?.summary ?? item)).filter(Boolean);
  const name = (id) => asArray(foundation?.characters).find((c) => c.id === id)?.canonicalName ?? id;
  const cast = asArray(episodePlan?.cast);
  const deferred = [text(episodePlan?.costCreatedByResolution?.deferred), text(episodePlan?.exitValue?.nextQuestion)].filter(Boolean);
  const withheld = asArray(episodePlan?.withheld).map(text).filter(Boolean);
  return {
    profileText: [profileText(profile, kit), settled.length ? t.settledNote(settled.join('; ')) : ''].filter(Boolean).join('\n') || kit.phrases.common.noneParen,
    arcBeatText: renderArcBeat(arcEpisode, kit) || kit.phrases.common.noneParen,
    planNotesText: [
      cast.length ? t.castNames(cast.map((id) => `${name(id)} (${id})`).join(', ')) : '',
      withheld.length ? t.withheldNote(withheld.join('; ')) : '',
      deferred.length ? t.deferredNote(deferred.join('; ')) : '',
    ].filter(Boolean).join('\n') || kit.phrases.common.noneParen,
    prose,
  };
}
