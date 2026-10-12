// 1000-stroke endurance regression. Browser-only test, not part of paint runtime.
import {spawn} from "node:child_process";
import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
const server=process.env.PFX_TEST_URL||"http://127.0.0.1:8732/";
const port=9336;
const folder=await mkdtemp(path.join(tmpdir(),"pfx-endurance-"));
await mkdir("test-artifacts",{recursive:true});
const chrome=spawn(process.argv[2]||"google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage","--disable-gpu",
 "--no-first-run","--disable-background-networking","--disable-extensions",
 "--remote-debugging-port="+port,"--user-data-dir="+path.join(folder,"profile"),
 "--window-size=1440,900","about:blank"
],{stdio:["ignore","ignore","pipe"]});
let page;
const errors=[];
const results={browser:"Chromium",resolution:[1200,800],totalStrokes:1000,milestones:[],integrity:[]};
async function until(fn,label,timeout=30000){
 const start=Date.now();while(Date.now()-start<timeout){
  try{const value=await fn();if(value)return value;}catch{}
  await sleep(150);
 }
 throw Error("Timeout: "+label);
}
async function connect(url){
 const ws=new WebSocket(url);
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 let next=0;const tasks=new Map();
 ws.addEventListener("message",event=>{
  const msg=JSON.parse(event.data);
  if(msg.method==="Runtime.exceptionThrown")errors.push(msg.params.exceptionDetails?.exception?.description||msg.params.exceptionDetails?.text);
  const task=tasks.get(msg.id);if(!task)return;
  tasks.delete(msg.id);
  msg.error?task.reject(Error(msg.error.message)):task.resolve(msg.result);
 });
 return {
  send(method,params={}){
   const id=++next;
   return Promise.race([
    new Promise((resolve,reject)=>{tasks.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));}),
    sleep(90000).then(()=>{throw Error("CDP timeout "+method);})
   ]);
  },
  async evaluate(expression){
   const answer=await this.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
   if(answer.exceptionDetails)throw Error(answer.exceptionDetails.exception?.description||answer.exceptionDetails.text);
   return answer.result.value;
  },
  close(){ws.close();}
 };
}
const mib=bytes=>Math.round(bytes/1048576*10)/10;
const check=(condition,msg)=>{if(!condition)throw Error(msg);};
try{
 const address=await until(async()=>{
  const response=await fetch("http://127.0.0.1:"+port+"/json/list");
  return(await response.json()).find(x=>x.type==="page")?.webSocketDebuggerUrl;
 },"Chrome debugger");
 page=await connect(address);
 await page.send("Page.enable");await page.send("Runtime.enable");
 await page.send("Performance.enable");await page.send("HeapProfiler.enable");
 await page.send("Page.navigate",{url:server});
 await until(async()=>(await page.evaluate("document.querySelector('#status')?.textContent||''")).includes("Ready to paint"),"WASM ready");

const SETUP="(async()=>{\n const {PaintingEngine}=await import(\"./src/engine.js\");\n const {openArtworkDatabase,createAutosave}=await import(\"./src/autosave.js\");\n const canvas=document.createElement(\"canvas\");canvas.width=1200;canvas.height=800;\n const engine=await PaintingEngine.create(canvas,()=>{});\n const db=await openArtworkDatabase();\n const statuses=[];\n const autosave=createAutosave(db,status=>statuses.push(status));\n window.__pfxLong={engine,canvas,db,statuses,autosave,next:0,tick:1000,rect:{left:0,top:0,width:1200,height:800}};\n return {ready:!!engine.active&&!!db};\n})()";
const DRAW="(async()=>{\n const s=window.__pfxLong,e=s.engine,times=[];\n const brushes=[\"pencil\",\"charcoal\",\"calligraphy\",\"brush\",\"marker_fat\"];\n for(let n=s.next;n<window.__pfxEnd;n++){\n   if(n%50===0)e.configure({brushId:brushes[Math.floor(n/50)%brushes.length],size:0,eraser:false});\n   const x=60+(n*59)%1010,y=70+(n*43)%640;\n   s.tick+=19;\n   const event=(a,b)=>({clientX:a,clientY:b,pressure:1,pointerType:\"mouse\",timeStamp:s.tick});\n   const start=performance.now();\n   e.begin(event(x,y),s.rect);\n   for(let i=1;i<=12;i++){\n     s.tick+=11;\n     e.add(event(x+i*2.4,y+Math.sin(i*.47+n*.13)*12),s.rect);\n   }\n   e.end();\n   times.push(performance.now()-start);\n   if(n%50===49)await new Promise(resolve=>requestAnimationFrame(resolve));\n }\n s.next=window.__pfxEnd;\n await new Promise(resolve=>requestAnimationFrame(resolve));\n const sorted=times.sort((a,b)=>a-b);\n return {count:e.history.length,\n   points:e.history.reduce((total,stroke)=>total+stroke.points.length,0),\n   strokeMs:{median:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor((sorted.length-1)*.95)],max:sorted.at(-1)},\n   checkpoints:e.checkpoints.length,wasmBytes:e.wasm.memory.buffer.byteLength\n };\n})()";
const VERIFY="(async()=>{\n const s=window.__pfxLong,e=s.engine;\n const digest=async canvas=>{\n   const bytes=canvas.getContext(\"2d\").getImageData(0,0,1200,800).data;\n   const hash=new Uint8Array(await crypto.subtle.digest(\"SHA-256\",bytes));\n   return Array.from(hash,b=>b.toString(16).padStart(2,\"0\")).join(\"\");\n };\n e.renderNow();\n const baseline=await digest(s.canvas);\n const undo=[],redo=[];\n for(let i=0;i<8;i++){const t=performance.now();e.undo();undo.push(performance.now()-t);}\n for(let i=0;i<8;i++){const t=performance.now();e.redo();redo.push(performance.now()-t);}\n e.renderNow();\n const redone=await digest(s.canvas);\n const snapshot=e.snapshot();\n const copyCanvas=document.createElement(\"canvas\");\n copyCanvas.width=1200;copyCanvas.height=800;\n const clone=new e.constructor(copyCanvas,e.wasm,e.brushSources,()=>{});\n const t0=performance.now();\n clone.restoreArtwork(snapshot);\n const restoreMs=performance.now()-t0;\n const recovered=await digest(copyCanvas);\n clone.releaseCheckpoints();clone.active.free();clone.surface.free();\n const saveStart=performance.now();\n s.autosave.save(()=>e.snapshot());\n let record=null;\n for(let attempt=0;attempt<90;attempt++){\n   await new Promise(resolve=>setTimeout(resolve,80));\n   record=await new Promise((resolve,reject)=>{\n     const tx=s.db.transaction(\"artwork\",\"readonly\"),req=tx.objectStore(\"artwork\").get(\"current\");\n     req.onsuccess=()=>resolve(req.result||null);\n     req.onerror=()=>reject(req.error);\n   });\n   if(record?.history?.length===s.next)break;\n }\n return {strokes:s.next,checksumSame:baseline===redone&&baseline===recovered,\n  undoMedian:undo.sort((a,b)=>a-b)[4],redoMedian:redo.sort((a,b)=>a-b)[4],\n  restoreMs,persisted:record?.history?.length===s.next,\n  persistenceMs:performance.now()-saveStart,\n  savedPoints:record?.history?.reduce((sum,stroke)=>sum+stroke.points.length,0)||0,\n  saveFailed:s.statuses.includes(\"Save failed\")};\n})()";

 const started=await page.evaluate(SETUP);
 check(started.ready,"Could not initialize long-session fixture");
 for(const end of [250,500,750,1000]){
  await page.evaluate("window.__pfxEnd="+end);
  const batch=await page.evaluate(DRAW);
  check(batch.count===end&&batch.points>=end*12,"Truncated stroke history at "+end);
  check(batch.checkpoints<=3,"Checkpoint limit exceeded at "+end);
  await page.send("HeapProfiler.collectGarbage");
  const performanceMetrics=await page.send("Performance.getMetrics");
  const values=Object.fromEntries(performanceMetrics.metrics.map(x=>[x.name,x.value]));
  const item={
   strokes:end,points:batch.points,strokeMs:batch.strokeMs,checkpoints:batch.checkpoints,
   wasmBufferMiB:mib(batch.wasmBytes),jsHeapAfterGcMiB:mib(values.JSHeapUsedSize||0),
   nodes:values.Nodes??null
  };
  results.milestones.push(item);
  console.log("ENDURANCE_MILESTONE "+JSON.stringify(item));
  if(end===500||end===1000){
   const outcome=await page.evaluate(VERIFY);
   check(outcome.checksumSame,"Pixels changed across undo/redo/recovery at "+end);
   check(outcome.persisted&&!outcome.saveFailed,"Autosave failed at "+end);
   check(outcome.savedPoints>=batch.points,"Persisted path truncated at "+end);
   results.integrity.push(outcome);
   console.log("ENDURANCE_INTEGRITY "+JSON.stringify(outcome));
  }
 }
 check(!errors.length,"Browser exceptions: "+errors.join("; "));
 results.uncaughtErrors=0;
 console.log("ENDURANCE_REPORT "+JSON.stringify(results));
 console.log("ENDURANCE_TEST_PASSED");
 await writeFile("test-artifacts/endurance-report.json",JSON.stringify(results,null,2)+"\n");
}catch(error){
 results.failure=String(error.message||error);
 console.error("ENDURANCE_FAILED "+(error.stack||error));
 process.exitCode=1;
 await writeFile("test-artifacts/endurance-report.json",JSON.stringify(results,null,2)+"\n");
}finally{
 page?.close();chrome.kill("SIGTERM");
 await sleep(200);
 await rm(folder,{recursive:true,force:true}).catch(()=>{});
}
