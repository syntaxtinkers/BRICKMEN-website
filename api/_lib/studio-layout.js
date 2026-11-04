'use strict';
const { sendJson, methodNotAllowed, requireAdmin } = require('./admin');
const base = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = () => process.env.SUPABASE_SECRET_KEY || '';
async function db(path, method, body, prefer) {
  const response = await fetch(base() + '/rest/v1/' + path, {
    method: method || 'GET',
    headers: { apikey:key(), Authorization:'Bearer '+key(), 'Content-Type':'application/json', Accept:'application/json', ...(prefer?{Prefer:prefer}:{}) },
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const raw=await response.text();let data=null;try{data=raw?JSON.parse(raw):null;}catch(_){}
  if(!response.ok)throw new Error(data&&(data.message||data.details)||'Project layout could not be saved (HTTP '+response.status+').');
  return data;
}
function bodyOf(req){if(req.body&&typeof req.body==='object')return req.body;if(typeof req.body==='string'){try{return JSON.parse(req.body);}catch(_){}}return {};}
module.exports=async function projectLayout(req,res){
 const user=await requireAdmin(req,res);if(!user)return;
 try{
  const projectId=String((req.method==='GET'?(req.query&&req.query.projectId):bodyOf(req).projectId)||'');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId))return sendJson(res,400,{error:'A valid project ID is required.'});
  if(req.method==='GET'){
   const rows=await db('brickmen_project_layouts?select=*&project_id=eq.'+encodeURIComponent(projectId)+'&limit=1');
   return sendJson(res,200,{layout:Array.isArray(rows)&&rows.length?rows[0]:null});
  }
  if(req.method!=='POST')return methodNotAllowed(res,['GET','POST']);
  const body=bodyOf(req);if(!body.draft_layout||typeof body.draft_layout!=='object'||Array.isArray(body.draft_layout))return sendJson(res,400,{error:'The layout data is invalid.'});
  const serialized=JSON.stringify(body.draft_layout);if(serialized.length>150000)return sendJson(res,413,{error:'This page layout is too large to save.'});
  const row={project_id:projectId,grid_size_mm:5,canvas:body.canvas&&typeof body.canvas==='object'?body.canvas:{width:240,columns:48,unit:'grid'},draft_layout:body.draft_layout,updated_by:user.id,updated_at:new Date().toISOString()};
  const rows=await db('brickmen_project_layouts?on_conflict=project_id','POST',row,'resolution=merge-duplicates,return=representation');
  return sendJson(res,200,{layout:Array.isArray(rows)?rows[0]:row});
 }catch(error){return sendJson(res,503,{error:error&&error.message?error.message:'Project layout service is unavailable.'});}
};
