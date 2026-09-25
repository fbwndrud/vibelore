import test from 'node:test';
import assert from 'node:assert/strict';
import { runWebtoonSceneTool } from '../src/tools/webtoon-scene.js';
import { sceneSetup, scenePlan, scenePreflight } from './fixtures/webtoon-scene.js';

const PROSE = {
  ko: '윤이 닫힌 문 앞에 멈췄다.\n\n"안에 있나요?"',
  en: 'Yun stopped at the closed door.\n\n"Is anyone inside?"',
  ja: 'ユンは閉じた扉の前で立ち止まった。\n\n「中にいますか?」',
  'zh-Hant': '尹停在緊閉的門前。\n\n「裡面有人嗎?」',
  es: 'Yun se detuvo ante la puerta cerrada.\n\n«¿Hay alguien dentro?»',
  ar: 'توقفت يون أمام الباب المغلق.\n\n«هل يوجد أحد في الداخل؟»',
  fr: 'Yun s’arrêta devant la porte fermée.\n\n« Il y a quelqu’un ? »',
  th: 'ยุนหยุดอยู่หน้าประตูที่ปิดสนิท\n\n"มีใครอยู่ข้างในไหม"',
};

function provider() {
  return { provenance: { kind: 'fixture' }, async complete(r) {
    const d = JSON.parse(r.messages.at(-1).content); let answer;
    if (r.step === 'webtoon-scene-plan') answer = scenePlan(d.source);
    else if (r.step === 'webtoon-scene-preflight') answer = scenePreflight(d);
    else answer = { ...d.schema, observedPanelCount: 6, inspectedImages: true, spatialCoherence: true, readingOrder: true, evidence: 'Fixture inspection.',
      textObservations: d.plan.texts.map(t => ({ id: t.id, observedText: t.text.normalize('NFD'), readable: true, speakerCorrect: true, evidence: 'Visible.' })) };
    return { text: JSON.stringify(answer) };
  } };
}

for (const [language, prose] of Object.entries(PROSE)) {
  test(`scene flow keeps ${language} lettering verbatim and names the script`, async () => {
    const { store, args } = await sceneSetup({ language, prose });
    const r = await runWebtoonSceneTool({ store, args, providers: provider() });
    assert.equal(r.jobs.length, 1, JSON.stringify(r));
    assert.ok(r.jobs[0].prompt.includes(JSON.stringify(prose.split('\n\n')[0])), 'source text quoted verbatim');
    assert.match(r.jobs[0].prompt, new RegExp(`All quoted text is in .*\\(${language}\\)`));
    if (language === 'ar') assert.match(r.jobs[0].prompt, /right-to-left/);

    const asset = { path: args.references[0].path, inputHash: r.jobs[0].inputHash,
      provenance: { kind: 'openai-api', requestedModel: 'gpt-image-2.5-sunburst', selectionId: 'selected-api' } };
    const result = await runWebtoonSceneTool({ store, args: { workId: args.workId, asset }, providers: provider() });
    assert.equal(result.status, 'completed', JSON.stringify(result));
  });
}
