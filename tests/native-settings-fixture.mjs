// Native SettingsForms with an in-memory ConfigEditor persistence seam.
// Runtime schemas, form validation, revision checking and notifications are real.
export async function installSettings(ctx, dsh) {
 const { SettingsForms } = await dsh('dsh-settings');
 const { updateVolatile } = await dsh('cosmokit');
 const entries=[];
 ctx.provide('loader',{await:async()=>{}});
 ctx.provide('profileContext',{home:'/tmp/dsh-fixture-no-legacy-document'});
 ctx.provide('configEditor',{
  documentPath:'/tmp/dsh-fixture-in-memory',
  entries:()=>entries.filter(e=>e.fiber.state===2),
  configuration:()=>entries.filter(e=>e.fiber.state===2).map(entry=>({entry,inherited:{},override:entry.options.config})),
  async edit(entry,change){
   const next=change(entry.options.config,{});
   // Mirror dsh-config-editor/lib/index.js:82-83: the internal/config waterfall runs
   // before persistence and its result is used only for validation. The RAW next value
   // is what gets stored, so a rejected edit must leave nothing behind.
   const resolved=entry.fiber.ctx.waterfall(entry.fiber,'internal/config',next,()=>next);
   const validated=entry.fiber.runtime.Config(resolved);
   for(const [key,value] of Object.entries(validated))updateVolatile(entry.fiber.config[key],value);
   entry.options.config=next;
  }
 });
 const settings=new SettingsForms(ctx);
 const attach=(id,fiber,raw={})=>{entries.push({id,options:{id,config:raw},fiber});settings.describe();};
 attach.entries=entries;
 return attach;
}
