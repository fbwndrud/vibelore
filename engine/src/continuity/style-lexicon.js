/**
 * Repetition cues authored for vibelore.
 * These short phrases are advisory signals when repeated, never forbidden words.
 * Pass a custom seed when a work needs different cues.
 */
import { ENGINE_GENRES } from './genre-profile.js';
export class DefaultStyleLexicon {
    byGenre;
    constructor(seed) {
        this.byGenre = new Map();
        const source = seed ?? STYLE_LEXICON_SEED;
        for (const entry of source) {
            const arr = this.byGenre.get(entry.genreId) ?? [];
            arr.push(entry);
            this.byGenre.set(entry.genreId, arr);
        }
    }
    forGenre(genreId) {
        return this.byGenre.get(genreId) ?? [];
    }
    all() {
        const out = [];
        for (const arr of this.byGenre.values())
            out.push(...arr);
        return out;
    }
}
const ko = ['그럴 수밖에 없었다', '무슨 말을 해야 할지', '달리 방법이 없었다', '그 사실만은 분명했다', '잠깐의 침묵이 흘렀다'];
const en = ['there was no other choice', 'one thing was certain', 'for reasons unknown', 'as if on cue', 'only time would tell'];
const zh = ['没有别的选择', '这一点很清楚', '一时说不出话', '事情并不简单', '时间会给出答案'];
const choices = {
  'streaming-litrpg': [ko, '댓글이 화면을 덮었다', '시청자 수가 치솟았다', '보상창이 시야를 가렸다'],
  'regression-hunter': [ko, '지난 생에서는 달랐다', '이번에는 놓치지 않는다', '나만 알고 있는 미래'],
  'villainess-isekai': [ko, '원작대로라면 오늘이었다', '악역에게 남은 선택', '소문은 이미 퍼져 있었다'],
  'academy-fantasy': [ko, '시험은 이제 시작이었다', '교실의 시선이 모였다', '성적표가 모든 것을 말했다'],
  'noble-clan-regression': [ko, '가문의 이름을 걸고', '혈통만으로 정해진 자리', '후계자의 자리는 비어 있었다'],
  'banishment-revenge': [ko, '돌아갈 곳은 없었다', '이 빚은 반드시 갚는다', '버림받은 날을 기억했다'],
  'mystery-thriller': [ko, '단서는 바로 앞에 있었다', '우연이라고 하기에는', '누군가는 거짓말을 하고 있었다'],
  action: [ko, '생각보다 몸이 먼저 움직였다', '승부는 한순간이었다', '물러설 자리는 없었다'],
  comedy: [ko, '문제는 그다음이었다', '왜 하필 지금인가', '아무도 웃지 않았다'],
  historical: [ko, '기록에는 남지 않았다', '왕명은 이미 내려졌다', '시대가 허락하지 않았다'],
  litrpg: [en, 'the numbers kept rising', 'another level awaited', 'the reward was immediate'],
  progression: [en, 'the next threshold beckoned', 'strength came at a price', 'the gap was still immense'],
  'system-apocalypse': [en, 'the rules had changed overnight', 'the countdown did not stop', 'survival was the only objective'],
  'tower-climber': [en, 'another floor another trial', 'the summit remained unseen', 'there was no way back down'],
  isekai: [en, 'this was no longer home', 'nothing worked as expected', 'the old world felt distant'],
  cultivation: [en, 'the bottleneck finally gave way', 'the path stretched onward', 'the heavens offered no answer'],
  xianxia: [zh, '修行没有尽头', '此劫终须面对', '山门依旧无声'],
  xuanhuan: [zh, '力量决定一切', '无人知道答案', '这场较量才刚开始'],
  'dungeon-core': [en, 'the dungeon needed more', 'the next room took shape', 'every intruder was a resource'],
  romantasy: [en, 'trust was harder than magic', 'the distance between them narrowed', 'neither would speak first'],
  'sci-fi': [en, 'the readings made no sense', 'the signal came again', 'the calculation left no margin'],
  horror: [zh, '门后没有回应', '脚步声又停了', '灯光忽明忽暗'],
  cozy: [en, 'there was always tomorrow', 'the kettle began to sing', 'the small ritual brought comfort'],
  urban: [zh, '城市照常运转', '消息传得很快', '人群没有停下'],
  other: [zh, '他没有再问', '她没有回头', '故事还没有结束'],
};
export const STYLE_LEXICON_SEED = ENGINE_GENRES.flatMap((genreId) => {
  const [common, ...specific] = choices[genreId];
  return [...common, ...specific].map((surface) => ({ genreId, surface, kind: 'cliche' }));
});
