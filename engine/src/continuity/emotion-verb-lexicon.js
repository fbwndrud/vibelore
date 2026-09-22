/**
 * EmotionVerbLexicon — Korean emotion-verb dictionary for layer-1
 * quality scans (N1 show-not-tell ratio, N6 emotion overtell).
 *
 * Each entry: surface verb form (past-tense conjugated, prose-typical),
 * categorical emotion tag, formality register. Lookup is exact substring
 * match. Layer-2 LLM (T8.4 scan) computes ratios over these tokens.
 */
export class DefaultEmotionVerbLexicon {
    entries;
    byEmotionMap;
    constructor(seed) {
        this.entries = new Map();
        this.byEmotionMap = new Map();
        const source = seed ?? KO_EMOTION_VERB_SEED;
        for (const entry of source) {
            this.entries.set(entry.verb, entry);
            const arr = this.byEmotionMap.get(entry.emotion) ?? [];
            arr.push(entry);
            this.byEmotionMap.set(entry.emotion, arr);
        }
    }
    lookup(verb) {
        return this.entries.get(verb);
    }
    byEmotion(emotion) {
        return this.byEmotionMap.get(emotion) ?? [];
    }
    all() {
        return [...this.entries.values()];
    }
}
/**
 * Korean emotion-verb seed. Past-tense narrative forms only (했다/었다/았다).
 * Sourced from common Korean web-novel prose. Layer-1 scan tokenizes and
 * does exact `verb` lookup; layer-2 LLM aggregates into N1/N6 metrics.
 */
export const KO_EMOTION_VERB_SEED = [
    // === sadness ===
    { verb: '슬펐다', emotion: 'sadness', register: 'narrative' },
    { verb: '울었다', emotion: 'sadness', register: 'narrative' },
    { verb: '눈물이 났다', emotion: 'sadness', register: 'narrative' },
    { verb: '눈물을 흘렸다', emotion: 'sadness', register: 'narrative' },
    { verb: '가슴이 미어졌다', emotion: 'sadness', register: 'narrative' },
    { verb: '가슴이 아팠다', emotion: 'sadness', register: 'narrative' },
    { verb: '흐느꼈다', emotion: 'sadness', register: 'narrative' },
    { verb: '비통했다', emotion: 'sadness', register: 'formal' },
    { verb: '서글펐다', emotion: 'sadness', register: 'narrative' },
    // === joy ===
    { verb: '기뻤다', emotion: 'joy', register: 'narrative' },
    { verb: '환호했다', emotion: 'joy', register: 'narrative' },
    { verb: '미소 지었다', emotion: 'joy', register: 'narrative' },
    { verb: '웃었다', emotion: 'joy', register: 'narrative' },
    { verb: '함박웃음을 지었다', emotion: 'joy', register: 'narrative' },
    { verb: '즐거웠다', emotion: 'joy', register: 'narrative' },
    { verb: '행복했다', emotion: 'joy', register: 'narrative' },
    { verb: '신이 났다', emotion: 'joy', register: 'casual' },
    { verb: '들떴다', emotion: 'joy', register: 'narrative' },
    // === anger ===
    { verb: '분노했다', emotion: 'anger', register: 'narrative' },
    { verb: '화가 났다', emotion: 'anger', register: 'narrative' },
    { verb: '화가 치밀었다', emotion: 'anger', register: 'narrative' },
    { verb: '이를 갈았다', emotion: 'anger', register: 'narrative' },
    { verb: '주먹을 쥐었다', emotion: 'anger', register: 'narrative' },
    { verb: '눈을 부릅떴다', emotion: 'anger', register: 'narrative' },
    { verb: '격노했다', emotion: 'anger', register: 'formal' },
    { verb: '성을 냈다', emotion: 'anger', register: 'narrative' },
    { verb: '짜증이 났다', emotion: 'anger', register: 'casual' },
    // === fear ===
    { verb: '두려웠다', emotion: 'fear', register: 'narrative' },
    { verb: '무서웠다', emotion: 'fear', register: 'narrative' },
    { verb: '떨렸다', emotion: 'fear', register: 'narrative' },
    { verb: '몸이 떨렸다', emotion: 'fear', register: 'narrative' },
    { verb: '식은땀이 흘렀다', emotion: 'fear', register: 'narrative' },
    { verb: '심장이 내려앉았다', emotion: 'fear', register: 'narrative' },
    { verb: '오싹했다', emotion: 'fear', register: 'narrative' },
    { verb: '겁이 났다', emotion: 'fear', register: 'narrative' },
    { verb: '간담이 서늘했다', emotion: 'fear', register: 'narrative' },
    // === shame ===
    { verb: '부끄러웠다', emotion: 'shame', register: 'narrative' },
    { verb: '얼굴이 붉어졌다', emotion: 'shame', register: 'narrative' },
    { verb: '얼굴이 화끈거렸다', emotion: 'shame', register: 'narrative' },
    { verb: '수치스러웠다', emotion: 'shame', register: 'formal' },
    { verb: '낯이 뜨거웠다', emotion: 'shame', register: 'narrative' },
    { verb: '민망했다', emotion: 'shame', register: 'narrative' },
    { verb: '쥐구멍에 숨고 싶었다', emotion: 'shame', register: 'narrative' },
    // === loneliness ===
    { verb: '외로웠다', emotion: 'loneliness', register: 'narrative' },
    { verb: '쓸쓸했다', emotion: 'loneliness', register: 'narrative' },
    { verb: '허전했다', emotion: 'loneliness', register: 'narrative' },
    { verb: '공허했다', emotion: 'loneliness', register: 'narrative' },
    { verb: '고독했다', emotion: 'loneliness', register: 'formal' },
    { verb: '적막했다', emotion: 'loneliness', register: 'narrative' },
    // === love ===
    { verb: '사랑했다', emotion: 'love', register: 'narrative' },
    { verb: '마음에 들었다', emotion: 'love', register: 'narrative' },
    { verb: '설렜다', emotion: 'love', register: 'narrative' },
    { verb: '심장이 뛰었다', emotion: 'love', register: 'narrative' },
    { verb: '두근거렸다', emotion: 'love', register: 'narrative' },
    { verb: '애틋했다', emotion: 'love', register: 'narrative' },
    { verb: '연모했다', emotion: 'love', register: 'formal' },
    // === hate ===
    { verb: '싫었다', emotion: 'hate', register: 'narrative' },
    { verb: '미웠다', emotion: 'hate', register: 'narrative' },
    { verb: '증오했다', emotion: 'hate', register: 'narrative' },
    { verb: '혐오스러웠다', emotion: 'hate', register: 'narrative' },
    { verb: '치를 떨었다', emotion: 'hate', register: 'narrative' },
    { verb: '진절머리가 났다', emotion: 'hate', register: 'narrative' },
    // === surprise ===
    { verb: '놀랐다', emotion: 'surprise', register: 'narrative' },
    { verb: '깜짝 놀랐다', emotion: 'surprise', register: 'narrative' },
    { verb: '입을 벌렸다', emotion: 'surprise', register: 'narrative' },
    { verb: '눈이 휘둥그레졌다', emotion: 'surprise', register: 'narrative' },
    { verb: '기겁했다', emotion: 'surprise', register: 'narrative' },
    { verb: '경악했다', emotion: 'surprise', register: 'formal' },
    { verb: '얼어붙었다', emotion: 'surprise', register: 'narrative' },
    // === disgust ===
    { verb: '역겨웠다', emotion: 'disgust', register: 'narrative' },
    { verb: '토할 것 같았다', emotion: 'disgust', register: 'narrative' },
    { verb: '구역질이 났다', emotion: 'disgust', register: 'narrative' },
    { verb: '눈살을 찌푸렸다', emotion: 'disgust', register: 'narrative' },
    { verb: '인상을 찌푸렸다', emotion: 'disgust', register: 'narrative' },
    { verb: '메스꺼웠다', emotion: 'disgust', register: 'narrative' },
    // === longing ===
    { verb: '그리웠다', emotion: 'longing', register: 'narrative' },
    { verb: '보고 싶었다', emotion: 'longing', register: 'narrative' },
    { verb: '사무쳤다', emotion: 'longing', register: 'narrative' },
    { verb: '간절했다', emotion: 'longing', register: 'narrative' },
    { verb: '애타게 기다렸다', emotion: 'longing', register: 'narrative' },
    { verb: '아련했다', emotion: 'longing', register: 'narrative' },
    // === pride ===
    { verb: '자랑스러웠다', emotion: 'pride', register: 'narrative' },
    { verb: '뿌듯했다', emotion: 'pride', register: 'narrative' },
    { verb: '가슴이 벅찼다', emotion: 'pride', register: 'narrative' },
    { verb: '으쓱했다', emotion: 'pride', register: 'casual' },
    { verb: '의기양양했다', emotion: 'pride', register: 'narrative' },
    // === guilt ===
    { verb: '죄책감을 느꼈다', emotion: 'guilt', register: 'narrative' },
    { verb: '미안했다', emotion: 'guilt', register: 'narrative' },
    { verb: '가책을 느꼈다', emotion: 'guilt', register: 'formal' },
    { verb: '후회했다', emotion: 'guilt', register: 'narrative' },
    { verb: '자책했다', emotion: 'guilt', register: 'narrative' },
    // === envy ===
    { verb: '부러웠다', emotion: 'envy', register: 'narrative' },
    { verb: '시샘했다', emotion: 'envy', register: 'narrative' },
    { verb: '질투했다', emotion: 'envy', register: 'narrative' },
    { verb: '샘이 났다', emotion: 'envy', register: 'casual' },
    { verb: '배가 아팠다', emotion: 'envy', register: 'casual' },
    // === relief ===
    { verb: '안도했다', emotion: 'relief', register: 'narrative' },
    { verb: '한숨을 내쉬었다', emotion: 'relief', register: 'narrative' },
    { verb: '안심했다', emotion: 'relief', register: 'narrative' },
    { verb: '마음이 놓였다', emotion: 'relief', register: 'narrative' },
    { verb: '가슴을 쓸어내렸다', emotion: 'relief', register: 'narrative' },
    // === contempt ===
    { verb: '경멸했다', emotion: 'contempt', register: 'narrative' },
    { verb: '비웃었다', emotion: 'contempt', register: 'narrative' },
    { verb: '코웃음을 쳤다', emotion: 'contempt', register: 'narrative' },
    { verb: '하찮게 여겼다', emotion: 'contempt', register: 'narrative' },
    { verb: '깔보았다', emotion: 'contempt', register: 'narrative' },
    { verb: '멸시했다', emotion: 'contempt', register: 'formal' },
];
