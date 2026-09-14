const MODEL = { provider: 'host', modelId: 'host-agent' };
const text = (v, n = 800) => String(v ?? '').trim().slice(0, n);
const list = (v, n = 10) => Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, n) : [];
const parse = (raw) => { try { return JSON.parse(String(raw).replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim()); } catch { return null; } };

export function renderStoryIdentity(identity) {
  if (!identity) return '';
  return ['## StoryIdentity — 작품 고유 재미', `- 독자 약속: ${identity.readerPromise}`, `- 주인공 매력: ${identity.protagonistAppeal}`,
    `- 고유 능력 표현: ${identity.competenceSignature.join('; ')}`, `- 감정적 결함: ${identity.emotionalDefect}`,
    `- 코미디 엔진: ${identity.comedyEngines.join('; ')}`, `- 해결 방식 순환: ${identity.solutionPatternsToRotate.join('; ')}`].join('\n');
}

export function renderPilotContract(contract) {
  if (!contract) return '';
  return ['## 1화 PilotContract — 장르 소개보다 인물의 선택이 먼저다', `- 시작 전 상태: ${contract.beforeState}`,
    `- 첫 실패: ${contract.firstFailure}`, `- 주인공만의 행동: ${contract.protagonistSpecificAction}`,
    `- 되돌릴 수 없는 선택: ${contract.irreversibleChoice}`, `- 능력 증명: ${contract.competenceProof}`,
    `- 인간적 질문: ${contract.humanHook}`, `- 시리즈 약속: ${contract.seriesPromise}`, `- 종료 질문: ${contract.closingQuestion}`,
    '- 첫 추론을 완벽한 정답으로 만들지 말고 실패·오차·수정 중 하나를 장면으로 보여준다.',
    '- 차원이동의 상실을 요약으로 건너뛰지 말고 현재 선택의 원인으로 체감시킨다.'].join('\n');
}

export function renderPatternLedger(entries) {
  if (!entries?.length) return '## 최근 PatternLedger\n- 아직 기록 없음';
  return ['## 최근 PatternLedger — 같은 해결법·농담·조연 기능을 반복하지 않는다.', ...entries.slice(-5).map((e) =>
    `- ${e.chapter}화: 해결=${e.solutionPattern}; 선택=${e.moralChoice || '미분류'}; 대가=${e.costShape || '미분류'}; 증거=${e.evidenceFamily || '미분류'}; 장면=${e.sceneMode || '미분류'}; 정서=${e.emotionalTemperature || '미분류'}; 결말=${e.endingImage || '미분류'}; 코미디=${e.comedyMechanism}; 주인공 방식=${e.protagonistMethod}; 오차·수정=${e.mistakeAndCorrection || '없음'}; 조연 행위=${Object.entries(e.supportingAgency ?? {}).map(([k,v]) => `${k}:${v}`).join(', ') || '없음'}`)].join('\n');
}

export async function ensureStoryIdentity({ store, workId, profile, foundation, providers }) {
  const existing = await store.loadStoryIdentity(workId);
  if (existing) return existing;
  const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'story-identity', messages: [
    { role: 'system', content: '한국 상업 웹소설의 작품 고유 반복 엔진을 설계한다. 추상 형용사가 아니라 장면에서 구분 가능한 능력·결함·코미디·해결 방식으로 쓴다. 순수 JSON만 출력한다.' },
    { role: 'user', content: `브리프: ${foundation?.brief ?? profile?.sourceBrief ?? ''}\n장르: ${profile?.genreLabel ?? foundation?.genre}\nJSON: {"readerPromise":"","protagonistAppeal":"","competenceSignature":[""],"emotionalDefect":"","comedyEngines":[""],"solutionPatternsToRotate":[""]}` },
  ] });
  if ((providers.pending?.length ?? 0) > 0) return null;
  const o = parse(response.text) ?? {};
  const identity = { workId, readerPromise: text(o.readerPromise || profile?.storyEngines?.join('·') || '주인공의 선택이 판을 바꾸는 쾌감'),
    protagonistAppeal: text(o.protagonistAppeal || '결함과 대가를 가진 유능한 주인공'), competenceSignature: list(o.competenceSignature).length ? list(o.competenceSignature) : ['불완전한 정보에서 판단하고 오차를 수정한다'],
    emotionalDefect: text(o.emotionalDefect || '능력이 인간관계를 해결해 주지는 않는다'), comedyEngines: list(o.comedyEngines).length ? list(o.comedyEngines) : ['절박한 목적과 제도의 충돌'],
    solutionPatternsToRotate: list(o.solutionPatternsToRotate).length ? list(o.solutionPatternsToRotate) : ['환경 이용','상대 의도 역산','아군 조합','정보전','손실 교환'], createdAt: new Date().toISOString() };
  await store.saveStoryIdentity(workId, identity); return identity;
}

export async function ensurePilotContract({ store, workId, identity, foundation, arcPlan, providers }) {
  const existing = await store.loadPilotContract(workId); if (existing) return existing;
  const response = await providers.complete({ model: MODEL, jsonMode: true, step: 'pilot-contract', messages: [
    { role: 'system', content: '1화를 설정 소개가 아니라 주인공의 실패→고유 행동→대가→되돌릴 수 없는 선택으로 설계한다. 첫 추론은 완벽하게 맞히지 않는다. 순수 JSON만 출력한다.' },
    { role: 'user', content: `${renderStoryIdentity(identity)}\n전제: ${foundation?.premise ?? foundation?.brief ?? ''}\n아크 약속: ${arcPlan?.promise ?? ''}\nJSON: {"beforeState":"","firstFailure":"","protagonistSpecificAction":"","irreversibleChoice":"","competenceProof":"","humanHook":"","seriesPromise":"","closingQuestion":""}` },
  ] });
  if ((providers.pending?.length ?? 0) > 0) return null;
  const o = parse(response.text) ?? {}; const contract = { workId, beforeState:text(o.beforeState), firstFailure:text(o.firstFailure), protagonistSpecificAction:text(o.protagonistSpecificAction), irreversibleChoice:text(o.irreversibleChoice), competenceProof:text(o.competenceProof), humanHook:text(o.humanHook), seriesPromise:text(o.seriesPromise || identity?.readerPromise), closingQuestion:text(o.closingQuestion), createdAt:new Date().toISOString() };
  await store.savePilotContract(workId, contract); return contract;
}

export async function runReaderHook({ chapter, prose, identity, pilotContract, episodePlan, contract = '', recentHookTypes = [], providers }) {
  const response = await providers.complete({ model:MODEL,jsonMode:true,step:'reader-hook',messages:[
    {role:'system',content:'한국 상업 웹소설 회차의 독자 경험을 승인된 작품 약속에 비추어 평가한다. 사건 수가 아니라 독자 가설의 갱신 속도, 약속의 장면 지급, 인물이 만든 전환, 해결이 낳은 비용, 앞 단서 재해석, 상대와 조연의 독립 행동, 구체적인 다음 가치를 본다. pass 판단에는 반드시 본문의 짧은 근거 구절이나 장면 위치를 든다. 계획에만 있고 본문에 없으면 지급으로 인정하지 않는다. 해당 회차에 지급할 약속과 의도적으로 뒤에 지급할 약속을 구분한다. 취미의 구입·설명과 실제 사용·즐거움을 구분하며 어떤 반응에서 인물성이 드러나는지 본문으로 판단한다. 모든 화에 같은 웃음·손실·밈을 강제하지 않는다. 순수 JSON만 출력한다.'},
    {role:'user',content:`회차: ${chapter}\n승인된 작품 계약:\n${contract}\n${renderStoryIdentity(identity)}\n${chapter===1?renderPilotContract(pilotContract):''}\nEpisodePlan:\n${JSON.stringify(episodePlan ?? {})}\n최근 훅 유형: ${JSON.stringify(recentHookTypes)}\n본문:\n${prose}\nJSON: {"score":0,"dimensions":{"protagonistAttachment":0,"competenceProof":0,"choiceAndCost":0,"supportingAgency":0,"nextChapterPull":0},"commercialSerialCheck":{"genrePromisePaid":{"verdict":"pass|warn|fail","evidence":""},"onPageExpectationEvidence":{"verdict":"pass|fail","evidence":""},"characterCausedTurn":{"verdict":"pass|warn|fail","evidence":""},"payoffBeforeNewDebt":{"verdict":"pass|warn|fail","evidence":""},"resolutionCreatesCost":{"verdict":"pass|warn|fail","evidence":""},"priorClueReinterpreted":{"verdict":"pass|warn|na","evidence":""},"opponentHasAgency":{"verdict":"pass|warn|na","evidence":""},"hookValueIsSpecific":{"verdict":"pass|warn|fail","evidence":""},"hookTypeVariety":{"verdict":"pass|warn","evidence":""},"metadataLeak":{"verdict":"pass|fail","evidence":""}},"findings":[{"code":"WEAK_PROTAGONIST_HOOK|GENERIC_COMPETENCE|COST_FREE_CHOICE|PASSIVE_SUPPORT|WEAK_NEXT_PULL|MISSING_EXPECTATION_EVIDENCE|UNPAID_PROMISE|AUTHOR_FORCED_TURN|NO_RESOLUTION_COST|VAGUE_EXIT_VALUE|HOOK_TYPE_REPETITION|METADATA_LEAK","message":"본문 근거와 최소 수정 방향"}]}`}
  ]}); const o=parse(response.text); return {score:typeof o?.score==='number'?Math.round(o.score):null,dimensions:o?.dimensions??{},commercialSerialCheck:o?.commercialSerialCheck??{},findings:Array.isArray(o?.findings)?o.findings.slice(0,10):[]};
}

export async function runPatternAnalysis({ chapter, prose, providers }) {
  const response=await providers.complete({model:MODEL,jsonMode:true,step:'pattern-ledger',messages:[{role:'system',content:'회차의 표면 소재가 아니라 독자가 실제로 경험한 서사 패턴을 정규화해 추출한다. 서로 다른 표현이 같은 기능이면 같은 짧은 범주명을 쓴다. 해결 방식·도덕적 선택·대가의 형태·결정적 증거 계열·주 장면 모드·정서 온도·마지막 이미지·코미디 구조·주인공 사고법·판단 오차와 수정·조연의 독립 행동·마지막 훅 유형을 기록한다. 순수 JSON만 출력한다.'},{role:'user',content:`본문:\n${prose}\nJSON: {"solutionPattern":"환경이용|규칙재해석|협상|전투|희생|정보전|관계선택|기타","moralChoice":"사람vs성과처럼 선택의 양쪽을 짧게","costShape":"신체|관계|지위|자원|정보|시간|정체성|없음|기타","evidenceFamily":"문서|수치|물증|증언|행동모순|공간흔적|감각|없음|기타","sceneMode":"전투|협상|조사|훈련|이동|휴식|재판|침투|기타","emotionalTemperature":"경쾌|긴장|공포|분노|슬픔|친밀|수치|해방|기타","endingImage":"문서봉인|검은증거|부상|이별|새인물|공간변화|규칙고지|관계행동|기타","comedyMechanism":"","protagonistMethod":"","mistakeAndCorrection":"","supportingAgency":{"characterId":"독립적으로 한 선택"},"hookType":"result|reinterpretation|relationship|ability|moral|identity|none"}`} ]});
  const o=parse(response.text)??{}; return {
    chapter,
    solutionPattern:text(o.solutionPattern,200), moralChoice:text(o.moralChoice,200), costShape:text(o.costShape,100),
    evidenceFamily:text(o.evidenceFamily,100), sceneMode:text(o.sceneMode,100), emotionalTemperature:text(o.emotionalTemperature,100),
    endingImage:text(o.endingImage,100), comedyMechanism:text(o.comedyMechanism,200), protagonistMethod:text(o.protagonistMethod,200),
    mistakeAndCorrection:text(o.mistakeAndCorrection,300), supportingAgency:o.supportingAgency&&typeof o.supportingAgency==='object'?o.supportingAgency:{}, hookType:text(o.hookType,40),
  };
}

export function patternViolations(entries, current) {
  const recent=entries.slice(-2); const out=[];
  for(const field of ['solutionPattern','comedyMechanism','protagonistMethod']) if(current[field]&&recent.length===2&&recent.every((e)=>e[field]===current[field])) out.push({severity:'soft',code:'PATTERN_REPETITION',message:`최근 3화가 같은 ${field}(${current[field]})을 반복한다. 다른 방식으로 수정하라.`});
  const semanticFields = {
    moralChoice: ['MORAL_CHOICE_REPETITION', '도덕적 선택'], costShape: ['COST_SHAPE_REPETITION', '대가 형태'],
    evidenceFamily: ['EVIDENCE_FAMILY_REPETITION', '증거 계열'], sceneMode: ['SCENE_MODE_REPETITION', '주 장면 모드'],
    emotionalTemperature: ['EMOTIONAL_TEMPERATURE_REPETITION', '정서 온도'], endingImage: ['ENDING_IMAGE_REPETITION', '결말 이미지'],
  };
  for (const [field, [code, label]] of Object.entries(semanticFields)) {
    if (current[field] && recent.length === 2 && recent.every((entry) => entry[field] === current[field])) {
      out.push({ severity: 'soft', code, message: `최근 3화가 표현만 달리한 같은 ${label}(${current[field]})를 반복한다. 이번 화의 서사 기능을 바꿔라.` });
    }
  }
  const analyzed = Boolean(current.solutionPattern || current.protagonistMethod)
    && recent.every((e) => e.solutionPattern || e.protagonistMethod);
  if (recent.length===2 && analyzed && !current.mistakeAndCorrection && recent.every((e)=>!e.mistakeAndCorrection)) out.push({severity:'soft',code:'PERFECT_JUDGMENT_STREAK',message:'최근 3화에서 주인공 판단의 오차·반론·수정이 없다.'});
  if (current.hookType && current.hookType !== 'none' && recent.length === 2 && recent.every((e) => e.hookType === current.hookType)) out.push({severity:'soft',code:'HOOK_TYPE_REPETITION',message:`최근 3화가 같은 ${current.hookType} 훅으로 끝난다. 다음 회차 가치의 종류를 바꿔라.`});
  return out;
}
