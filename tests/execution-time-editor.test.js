const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function harness(accept=true){
 const listeners={};let saves=0,last;
 const button=(name)=>({addEventListener:(event,cb)=>{listeners[name+':'+event]=cb;}});
 const form={elements:{date:{value:'2026-10-31'},time:{value:'08:00'}},reportValidity:()=>true,addEventListener:(event,cb)=>{listeners['form:'+event]=cb;}};
 const dialog={open:true,setAttribute(){},close(){this.open=false;},querySelector(selector){return selector==='form'?form:button(selector);}};
 const context={createDialog:()=>dialog,stampParts:value=>({date:value.slice(0,10),clock:value.slice(11,16)}),nowStamp:()=> '2026-10-31T10:45',escapeHtml:x=>x};
 vm.runInNewContext(source.slice(source.indexOf('  function openExecutionTimeEditor('),source.indexOf('  function blankStep(')),context);
 context.openExecutionTimeEditor({value:'2026-10-31T08:00',field:'actualStart',stepName:'Etapa',onSave(value){saves++;last=value;return accept;}});
 return {dialog,form,listeners,saves:()=>saves,last:()=>last};
}
test('alterar dia, hora e minutos não salva nem fecha o editor',()=>{
 const h=harness();h.form.elements.date.value='2026-11-01';h.form.elements.time.value='09:00';h.form.elements.time.value='09:35';
 assert.equal(h.dialog.open,true);assert.equal(h.saves(),0);
 h.listeners['form:submit']({preventDefault(){}});
 assert.equal(h.saves(),1);assert.equal(h.last(),'2026-11-01T09:35');assert.equal(h.dialog.open,false);
});
test('cancelar descarta edição; horário atual apenas preenche até confirmar',()=>{
 const h=harness();h.listeners['[data-current-time]:click']();
 assert.equal(h.form.elements.time.value,'10:45');assert.equal(h.saves(),0);assert.equal(h.dialog.open,true);
 h.listeners['[data-cancel-time]:click']();assert.equal(h.dialog.open,false);assert.equal(h.saves(),0);
});
test('validação recusada mantém o editor e os valores escolhidos',()=>{
 const h=harness(false);h.form.elements.time.value='07:15';h.listeners['form:submit']({preventDefault(){}});
 assert.equal(h.dialog.open,true);assert.equal(h.form.elements.time.value,'07:15');
});
test('limpar usa a mesma validação dos horários e não salva automaticamente',()=>{
 const h=harness();assert.equal(h.saves(),0);h.listeners['[data-clear-time]:click']();
 assert.equal(h.last(),'');assert.equal(h.saves(),1);assert.equal(h.dialog.open,false);
});
