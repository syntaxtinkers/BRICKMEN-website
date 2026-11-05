'use strict';
const { sendJson, methodNotAllowed, requireAdmin } = require('./admin');
const base = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = () => process.env.SUPABASE_SECRET_KEY || '';
async function db(path, method, body, prefer) {
 const response = await fetch(base() + '/rest/v1/' + path, { method: method || 'GET', headers: { apikey:key(), Authorization:'Bearer '+key(), 'Content-Type':'application/json', Accept:'application/json', ...(prefer?{Prefer:prefer}:{}) }, ...(body===undefined?{}:{body:JSON.stringify(body)}) });
 const raw=await response.text();let data=null;try{data=raw?JSON.parse(raw):null;}catch(_){}
 if(!response.ok)throw new Error(data&&(data.message||data.details)||'Project AI preparation failed (HTTP '+response.status+').');return data;
}
function parseBody(req){if(req.body&&typeof req.body==='object')return req.body;if(typeof req.body==='string'){try{return JSON.parse(req.body);}catch(_){}}return {};}
function outputText(data){if(typeof data.output_text==='string')return data.output_text;const out=[];(data.output||[]).forEach(x=>(x.content||[]).forEach(y=>{if(y.type==='output_text'&&y.text)out.push(y.text);}));return out.join('\n');}
function parseJson(value){const s=String(value||'').replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();try{return JSON.parse(s);}catch(_){}const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a)return JSON.parse(s.slice(a,b+1));throw new Error('The AI service returned an unreadable project draft.');}
async function askAI(apiKey,input,maxTokens){
 const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-6.1-terra',input:[{role:'user',content:input}],max_output_tokens:maxTokens})});
 const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error&&data.error.message||'The AI writing service returned HTTP '+response.status+'.');return parseJson(outputText(data));
}
module.exports=async function generateProject(req,res){
 const user=await requireAdmin(req,res);if(!user)return;if(req.method!=='POST')return methodNotAllowed(res,['POST']);
 try{
  const body=parseBody(req),projectId=String(body.projectId||''),tone=String(body.tone||'Classy').slice(0,40),requestedTemplate=String(body.templateId||'ai-custom');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId))return sendJson(res,400,{error:'A valid project ID is required.'});
  const apiKey=process.env.OPENAI_API_KEY||'';if(!apiKey)return sendJson(res,503,{error:'AI writing is not connected. Add OPENAI_API_KEY as a Vercel Production secret and redeploy.'});
  const projects=await db('brickmen_projects?select=id,title,location,category,project_year,description,draft_content&id=eq.'+encodeURIComponent(projectId)+'&limit=1');
  if(!Array.isArray(projects)||!projects.length)return sendJson(res,404,{error:'Project not found.'});const project=projects[0];
  const media=await db('brickmen_project_media?select=id,file_name,mime_type,private_storage_path,is_hidden,caption,alt_text,sort_order,is_cover&project_id=eq.'+encodeURIComponent(projectId)+'&order=sort_order.asc');
  const visible=(Array.isArray(media)?media:[]).filter(x=>x.private_storage_path&&!x.is_hidden);
  if(!visible.length)return sendJson(res,409,{error:'Prepare at least one visible project photograph before arranging the page.'});
  const observations=[],skipped=[];
  for(let start=0;start<visible.length;start+=5){
   const batch=visible.slice(start,start+5),parts=[{type:'input_text',text:'You are an expert architectural photo editor. Examine EVERY photograph attached to this batch carefully. For each, return one JSON object in an observations array with exact file_name, precise visible description, spatial/material/light/landscape/composition observations, a concise factual magazine caption and accessible alt_text. Do not infer unshown facts. Return JSON only.'}];
   for(const item of batch){
    const file=await fetch(base()+'/storage/v1/object/brickmen-studio-private/'+item.private_storage_path,{headers:{apikey:key(),Authorization:'Bearer '+key()}});
    if(!file.ok){skipped.push(item.file_name);continue;}
    const bytes=Buffer.from(await file.arrayBuffer());if(bytes.length>3*1024*1024){skipped.push(item.file_name);continue;}
    const mime=['image/jpeg','image/png','image/webp','image/gif'].includes(item.mime_type)?item.mime_type:'image/jpeg';
    parts.push({type:'input_text',text:'Filename: '+item.file_name});parts.push({type:'input_image',detail:'high',image_url:'data:'+mime+';base64,'+bytes.toString('base64')});
   }
   if(parts.length>1){const batchResult=await askAI(apiKey,parts,3500);(Array.isArray(batchResult.observations)?batchResult.observations:[]).forEach(x=>observations.push(x));}
  }
  if(!observations.length)return sendJson(res,409,{error:'No supported imported photographs were available for AI analysis.'});
  const comic=tone.toLowerCase().includes('superhero')||tone.toLowerCase().includes('comic');
  const voice=comic?'Write a sophisticated, witty fictional Brickmen superhero comic feature. The team uses imaginative superpowers of light, space, structure, landscape and craft. Clearly label it as creative brand storytelling, never factual project history.':'Write like a leading architectural journalist for an internationally respected architecture magazine: perceptive, literate, specific, confident and critically observant. Avoid marketing fluff, generic praise, repetitive captions and AI-sounding phrases. Explain the architectural idea through the visible evidence.';
  const templateRows=await db('brickmen_project_layouts?select=project_id,draft_layout');
  const occupied=new Set((Array.isArray(templateRows)?templateRows:[]).filter(x=>x.project_id!==projectId&&x.draft_layout).map(x=>({editorial:'t01',minimal:'t04',gallery:'t03'}[x.draft_layout.template]||x.draft_layout.template)).filter(x=>/^t(0[1-9]|[1-3][0-9]|40)$/.test(x)));
  let assigned=requestedTemplate;
  if(requestedTemplate==='ai-custom')assigned='custom';
  else if(!/^t(0[1-9]|[1-3][0-9]|40)$/.test(requestedTemplate)||occupied.has(requestedTemplate)){
   assigned=Array.from({length:40},(_,i)=>'t'+String(i+1).padStart(2,'0')).find(x=>!occupied.has(x));
   if(!assigned)assigned='custom';
  }
  const instructions='Create a complete, publication-quality architectural magazine feature page for Brickmen. '+voice+'\nKnown facts only: '+JSON.stringify({title:project.title,location:project.location,category:project.category,year:project.project_year})+'\nPhoto-by-photo visual evidence (all page-visible photos have been examined in batches): '+JSON.stringify(observations)+'\nReturn ONLY valid JSON with keys title,category,description,photo_captions,sections,visual_direction,custom_theme.\nEditorial standard: opening description 130-180 words; 4-7 substantial editorial text blocks, each 55-95 words, with original headings and eyebrow labels; 10-20 total alternating blocks where photo count allows. Every analysed image must appear exactly once as an image section using its exact file_name. Never put all photos together; create a deliberate magazine sequence with a strong opener, full-bleed moments, intimate details, pauses, generous whitespace and a closing reflection. For each image section include file_name,width wide/medium/narrow,align left/center/right,aspect landscape/portrait/natural,caption. Text sections include type=text,eyebrow,heading,body,align. Photo captions must be precise, not speculative.\nArt direction: visual_direction must describe typography pairing, grid, hierarchy, image rhythm, whitespace, palette and layout. '+(assigned==='custom'?'Invent a completely new project-specific design system based on the architecture visible in the photographs. custom_theme must define a complete original visual system: paper,ink,accent as hex colours; font chosen from Georgia, serif / Arial, sans-serif / Palatino, serif / Courier New, monospace / Trebuchet MS, sans-serif; image_radius as 0px,2px,4px,8px,12px or 16px; hero_style chosen from split,stack,overlay,reverse,editorial; text_style chosen from rail,center,ink,frame,italic,caps,soft,rule,photo-edge,quiet. Give this design a memorable visual concept in visual_direction.':'Use the selected template ID '+assigned+' as the page identity; still make the page composition unique to this project.')+'\nAccuracy: only describe what the photographs show. Do not invent architect/client, exact address, use, dimensions, materials brands, construction methods, sustainability claims, awards, budget or dates. Clearly distinguish interpretation from known facts. Return JSON only.';
  const result=await askAI(apiKey,[{type:'input_text',text:instructions}],10000);
  const current=project.draft_content&&typeof project.draft_content==='object'?project.draft_content:{};
  const draft=Object.assign({},current,{title:String(result.title||current.title||project.title||'').slice(0,180),category:String(result.category||current.category||project.category||'').slice(0,240),description:String(result.description||current.description||project.description||'').slice(0,12000),ai_generated_at:new Date().toISOString(),ai_tone:tone,ai_review_required:true});
  await db('brickmen_projects?id=eq.'+encodeURIComponent(projectId),'PATCH',{draft_content:draft,updated_at:new Date().toISOString()});
  const captions=Array.isArray(result.photo_captions)?result.photo_captions:[];
  for(const o of observations){const cap=captions.find(x=>x.file_name===o.file_name)||o;const match=visible.find(x=>x.file_name===o.file_name);if(match)await db('brickmen_project_media?id=eq.'+encodeURIComponent(match.id),'PATCH',{caption:String(cap.caption||'').slice(0,500),alt_text:String(cap.alt_text||'').slice(0,500),updated_at:new Date().toISOString()});}
  const cover=visible.find(x=>x.is_cover)||visible[0],used=new Set(cover?[cover.id]:[]),sections=[];
  for(const section of (Array.isArray(result.sections)?result.sections:[]).slice(0,80)){
   if(!section||typeof section!=='object')continue;
   if(section.type==='text'){const bodyText=String(section.body||'').trim().slice(0,2400);if(bodyText)sections.push({type:'text',eyebrow:String(section.eyebrow||'DESIGN NOTE').slice(0,80),heading:String(section.heading||'').slice(0,160),body:bodyText,align:section.align==='center'?'center':'left'});}
   else if(section.type==='image'){const match=visible.find(x=>x.file_name===String(section.file_name||''));if(!match||used.has(match.id))continue;used.add(match.id);const cap=String(section.caption||(captions.find(x=>x.file_name===match.file_name)||{}).caption||match.caption||'').slice(0,500);sections.push({type:'image',mediaId:match.id,width:['wide','medium','narrow'].includes(section.width)?section.width:'wide',align:['left','center','right'].includes(section.align)?section.align:'center',aspect:['landscape','portrait','natural'].includes(section.aspect)?section.aspect:'natural',caption:cap,spaceAfter:'large'});}
  }
  // Guarantee that every visible photograph included in the AI visual analysis appears on the page.
  visible.filter(x=>!used.has(x.id)).forEach((item,i)=>{const o=observations.find(x=>x.file_name===item.file_name)||{};sections.push({type:'image',mediaId:item.id,width:i%4===0?'wide':i%4===1?'medium':'narrow',align:['left','right','center'][i%3],aspect:'natural',caption:String(o.caption||item.caption||'').slice(0,500),spaceAfter:'large'});});
  if(sections.filter(x=>x.type==='text').length<3&&draft.description)sections.splice(0,0,{type:'text',eyebrow:'THE ARCHITECTURAL IDEA',heading:'A reading of the place',body:draft.description,align:'left'});
  let y=3,ti=0,ii=0;
  const elements=sections.map(section=>{
   if(section.type==='text'){const w=ti%3===0?35:ti%3===1?29:32,x=section.align==='center'?Math.floor((48-w)/2)+1:([3,16,9][ti%3]),h=Math.max(9,Math.min(16,6+Math.ceil(String(section.body||'').length/95)));const item={...section,x,y,w,h};y+=h+(ti===0?8:7);ti++;return item;}
   const w=section.width==='narrow'?21:section.width==='medium'?31:44,x=section.align==='left'?2:section.align==='right'?48-w:Math.floor((48-w)/2)+1,h=section.aspect==='portrait'?34:section.aspect==='landscape'?24:(ii%2===0?27:30);const item={...section,x,y,w,h};y+=h+8;ii++;return item;
  });
  const direction=result.visual_direction&&typeof result.visual_direction==='object'?result.visual_direction:{};
  const layout={version:3,template:assigned,grid:{sizeMm:5,columns:48},composition:'magazine-feature',heroMediaId:cover?cover.id:null,visual_direction:direction,custom_theme:assigned==='custom'&&result.custom_theme&&typeof result.custom_theme==='object'?result.custom_theme:null,ai_generated_at:new Date().toISOString(),elements};
  await db('brickmen_project_layouts?on_conflict=project_id','POST',{project_id:projectId,grid_size_mm:5,canvas:{width:240,columns:48,unit:'grid'},draft_layout:layout,updated_by:user.id,updated_at:new Date().toISOString()},'resolution=merge-duplicates,return=minimal');
  return sendJson(res,200,{draft_content:draft,visual_direction:direction,analyzed_photos:observations.length,skipped_photos:skipped.length,template:assigned,template_name:assigned==='custom'?'AI-created original design':assigned,review_required:true});
 }catch(error){return sendJson(res,503,{error:error&&error.message?error.message:'AI project preparation is unavailable.'});}
};