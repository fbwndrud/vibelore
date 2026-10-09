import { previewReadiness } from './player.js';
import { productionProgress, goToWork } from './workflow.js';
import { el, note, button } from './dom.js';
export function renderManagement(c) {
  const s=c.snapshot, id=c.selection.production;
  if(!id)return note('제작판을 선택하면 준비 상태가 표시됩니다.');
  const p=productionProgress(s,id,c.selection.previewProfile??'landscape');
  const shots=p.scenes.flatMap(sc=>sc.shots), missing=p.readiness.audio[0];
  const missingImages=previewReadiness(s,id,'landscape').images.filter(image=>image.shotId!=null).length;
  const column=(title,...children)=>el('section',{class:'management-column'},el('h2',{},title),...children);
  const item=(title,text,action)=>el('article',{class:'management-item'},el('h3',{},title),note(text),action);
  const audioAction=button('누락 음성 준비',()=>{
    if(missing)goToWork(c,'assets',{scene:missing.sceneId,utterance:missing.utteranceId,assetKind:'audio',slot:'',candidate:''});
  },{disabled:!missing});
  const root=el('div',{class:'management-board'},
    column('연결된 자료',
      item('원작과 각색',`${p.scenes.length}개 장면 · ${p.readiness.utterances}개 발화`,button('대본에서 확인',()=>goToWork(c,'script'))),
      item('그림 참조',shots.length ? `${shots.length-missingImages}/${shots.length}개 샷 연결 · 촬영용 컷 품질은 별도 검수` : '샷이 없습니다. 장면에서 촬영용 샷을 추가하세요.',button('장면에서 확인',()=>goToWork(c,'edit'))),
      item('목소리 배정',p.steps[1].detail,button('배역과 목소리 확인',()=>goToWork(c,'cast')))),
    column('준비할 작업',
      item('대사 음원',missing?`${p.readiness.audio.length}개 발화의 음원이 필요합니다.`:'선택 타임라인의 음원 연결 확인됨',audioAction),
      p.rejection?item(`Google 요청 HTTP ${p.rejection.providerFailure.httpStatus}`,'실제 요청 기록입니다. 결과와 청구 여부를 확인해야 합니다. 자동 재전송하지 않습니다.',button('생성 기록 확인',()=>{c.focusEditor?.('generation-records');})):null,
      item('대화 간격과 카메라','구도 초안과 실제 음성 타이밍을 장면에서 확인합니다.',button('연출 계속하기',()=>goToWork(c,'edit')))),
    column('검수와 완성 파일',
      item('고정한 편집판',p.steps[3].detail,button('미리보기 확인',()=>c.focusEditor?.('production-preview'))),
      item('완성 파일',p.steps[4].detail,note(p.currentOutputs.length?'출력 영역에서 실제 파일을 재생하고 감상 검토를 기록하세요.':'선택 자료 준비 → 편집판 고정 → 실제 파일 출력 → 재생 검수')),
      item('저장과 생성 이력','원작 연결, 편집, 생성 결과를 실제 저장 순서로 확인합니다.',button('작품 이력 보기',()=>c.focusEditor?.('production-history')))));
  return root;
}
