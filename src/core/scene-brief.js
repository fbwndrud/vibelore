import { createHash } from 'node:crypto';

import { unsafePromptTextReason } from './draft-input-compiler.js';
import { tokenUnits } from './token-units.js';

import { asKit } from '../prompts/index.js';

// A scene is written from the user's own request, so the request is the whole packet.
export const SCENE_BRIEF_MAX_CHARS = 800;

/** Why a scene request cannot enter the writer prompt, or null. */
export function sceneBriefReason(brief) {
  const text = typeof brief === 'string' ? brief.trim() : '';
  if (!text) return 'scene-brief-required';
  if ([...text].length > SCENE_BRIEF_MAX_CHARS) return 'scene-brief-too-long';
  return unsafePromptTextReason(text);
}

/** The `needs_setup` code a rejected scene request maps to. */
export function sceneBriefCode(reason) {
  return reason === 'scene-brief-required' || reason === 'scene-brief-too-long'
    ? 'SCENE_BRIEF_REQUIRED'
    : 'SCENE_BRIEF_UNSAFE';
}

/**
 * Compiles the scene request into the `episode` packet the draft compiler expects.
 * The request is rendered verbatim; the only added text is the heading and the
 * one-scene rule from the work's prompt family.
 */
export function compileScenePacket({ brief, kit: kitSource } = {}) {
  const reason = sceneBriefReason(brief);
  if (reason) return { ok: false, error: { code: 'INVALID_DRAFT_INPUT', section: 'scene', reason } };
  const { draftInput } = asKit(kitSource).phrases;
  const text = brief.trim();
  const writerText = [draftInput.sceneHeading, text, draftInput.sceneRule].join('\n');
  return {
    ok: true,
    value: {
      writerText,
      usage: { usedTokens: tokenUnits(writerText) },
      trace: {
        kind: 'scene',
        briefHash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        includedFields: ['brief'],
      },
    },
  };
}
