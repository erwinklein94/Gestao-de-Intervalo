const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
function load() {
  const context = { console, crypto: { randomUUID: () => 'test-id' }, document: { body: { dataset: { page: 'test' } } }, localStorage: { getItem: () => null, setItem() {} }, window: { __GESTAO_TEST_MODE__: true, addEventListener() {} }, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  return context.window.__GESTAO_TEST_API__;
}
const api=load();
const item=(id, done=false, updatedAt='2026-10-30T20:00:00.000Z')=>({id,name:'Inspecionar',description:'Verificar equipamento',done,updatedAt});
test('subetapas sobrevivem ao banco e não alteram duração, prazo ou status',()=>{
  const plan=api.blankPlan('Teste',{date:'2026-10-30',windowStart:'2026-10-30T08:00',windowEnd:'2026-10-30T09:00'});
  plan.steps=[{...api.blankStep(),name:'Etapa',plannedStart:plan.windowStart,plannedEnd:plan.windowEnd,actualStart:plan.windowStart,actualEnd:plan.windowEnd}];
  const before=api.buildTimeline(plan);
  plan.steps[0].substeps=[item('a'),item('b',true)];
  const after=api.buildTimeline(plan);
  assert.equal(after.duration,before.duration);
  assert.equal(after.deadline,before.deadline);
  assert.equal(after.steps[0].actualDuration,before.steps[0].actualDuration);
  assert.equal(api.pendingSubsteps(plan.steps[0]).length,1);
  const payload=api.stepsToDatabase(plan);
  const restored=api.databaseToPlan({client_id:plan.id, interval_steps:payload});
  assert.equal(JSON.stringify(restored.steps[0].substeps),JSON.stringify(plan.steps[0].substeps));
});
test('planos antigos recebem lista vazia e payload inclui subetapas',()=>{
  const plan=api.blankPlan('Antigo'); plan.steps=[{id:'old',name:'Etapa'}]; api.normalizePlan(plan);
  assert.equal(plan.steps[0].substeps.length,0);
  assert.equal(api.stepsToDatabase(plan)[0].substeps.length,0);
});
test('merge offline preserva inclusões, exclusões e desmarcação mais recente',()=>{
  const older=item('a',true), newer=item('a',false,'2026-10-30T21:00:00.000Z');
  const result=api.mergeStep({substeps:[newer,item('b'),{...item('c',false,'2026-10-30T21:00:00.000Z'),deleted:true}]},{substeps:[older,item('c'),item('d')]},[]);
  assert.equal(result.substeps.length,4);
  assert.equal(result.substeps.find(x=>x.id==='a').done,false);
  assert.equal(result.substeps.find(x=>x.id==='c').deleted,true);
  assert.equal(api.pendingSubsteps(result).length,3);
});
test('renderização escapa conteúdo e identifica checks e itens pendentes',()=>{
  const step={substeps:[{...item('a'),name:'<img onerror="alert(1)">',description:'<script>bad</script>'},{...item('b'),deleted:true}]};
  const html=api.substepsHtml(step,'execute');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('data-substep-check="a"'));
  assert.ok(!html.includes('data-substep-check="b"'));
  assert.ok(api.substepsHtml(step,'execute',true).includes('disabled'));
});
function timeHarness(step) {
  const plan={date:'2026-10-30',status:'executing',steps:[step]};
  let saved=0, redraw=0, confirm;
  const context={plan, isStepSkipped:x=>x.executionStatus==='skipped',showToast(){},buildTimeline:api.buildTimeline,isStepComplete:x=>x.actualStartMinutes!=null&&x.actualEndMinutes!=null,pendingSubsteps:api.pendingSubsteps,confirmPendingSubsteps:(_s,callback)=>{confirm=callback;},persist(){saved++;},agendarRedesenho(){redraw++;}};
  const start=source.indexOf('    function updateActualTime(');
  const end=source.indexOf('\n    root.addEventListener("input"',start);
  vm.runInNewContext(source.slice(start,end)+'\nthis.update = updateActualTime;',context);
  return {context,saveCount:()=>saved,redrawCount:()=>redraw,confirm:()=>confirm?.()};
}
test('fim com pendências só é salvo após confirmar e mantém checks pendentes',()=>{
  const step={...api.blankStep(),actualStart:'2026-10-30T08:00',substeps:[item('a')]};
  const h=timeHarness(step);
  assert.equal(h.context.update(step,'actualEnd','2026-10-30T09:00'),false);
  assert.equal(step.actualEnd,''); assert.equal(h.saveCount(),0);
  h.confirm(); assert.equal(step.actualEnd,'2026-10-30T09:00'); assert.equal(h.saveCount(),1);
  assert.equal(step.substeps[0].done,false); assert.equal(h.redrawCount(),1);
});
test('sem pendências salva direto; horário inválido e intervalo encerrado não salvam',()=>{
  const step={...api.blankStep(),actualStart:'2026-10-30T08:00',substeps:[item('a',true)]};
  const h=timeHarness(step);
  assert.equal(h.context.update(step,'actualEnd','2026-10-30T07:00'),false);
  assert.equal(h.saveCount(),0);
  assert.equal(h.context.update(step,'actualEnd','2026-10-30T09:00'),true);
  h.context.plan.status='completed';
  assert.equal(h.context.update(step,'actualEnd','2026-10-30T10:00'),false);
  assert.equal(h.saveCount(),1);
});
test('cancelar não registra fim; plano encerrado enquanto modal aberto continua imutável',()=>{
  const step={...api.blankStep(),actualStart:'2026-10-30T08:00',substeps:[item('a')]};
  const h=timeHarness(step); h.context.update(step,'actualEnd','2026-10-30T09:00');
  assert.equal(step.actualEnd,''); assert.equal(h.saveCount(),0);
  h.context.plan.status='completed'; h.confirm();
  assert.equal(step.actualEnd,''); assert.equal(h.saveCount(),0);
});
