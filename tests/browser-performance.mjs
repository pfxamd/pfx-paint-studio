// Isolated long-session drawing benchmark: Chrome CDP, no test dependencies.
import {spawn} from "node:child_process";
import {mkdir,writeFile,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const base=process.env.PFX_TEST_URL||"http://127.0.0.1:8732/";
const port=9335;
const cpuSlowdown=Number(process.env.PFX_CPU_SLOWDOWN||1);
const strokeCount=Number(process.env.PFX_BENCH_STROKES||300);
if(!Number.isInteger(strokeCount)||strokeCount<72||strokeCount>2000||
   ![1,2,3,4,6].includes(cpuSlowdown))throw Error("Invalid benchmark configuration");
const dir=await mkdtemp(path.join(tmpdir(),"pfx-perf-"));
await mkdir("test-artifacts",{recursive:true});
const chrome=spawn(process.argv[2]||"google-chrome",[
  "--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",
  "--no-first-run","--disable-extensions","--disable-background-networking",
  "--remote-debugging-port="+port,"--user-data-dir="+path.join(dir,"profile"),
  "--window-size=1440,900","about:blank"
],{stdio:["ignore","ignore","pipe"]});
async function until(fn,label,timeout=30000){
  const start=Date.now();
  while(Date.now()-start<timeout){
    try{const value=await fn();if(value)return value;}catch{}
    await sleep(150);
  }
  throw Error("Timed out: "+label);
}
async function connect(url){
  const socket=new WebSocket(url);
  await new Promise((ok,bad)=>{
    socket.addEventListener("open",ok,{once:true});
    socket.addEventListener("error",bad,{once:true});
  });
  const awaiting=new Map();let counter=0;
  socket.addEventListener("message",e=>{
    const packet=JSON.parse(e.data),handler=awaiting.get(packet.id);
    if(!handler)return;
    awaiting.delete(packet.id);
    packet.error?handler.reject(Error(packet.error.message)):handler.resolve(packet.result);
  });
  return {
    send(method,params={}){
      const id=++counter;
      return Promise.race([
        new Promise((resolve,reject)=>{
          awaiting.set(id,{resolve,reject});
          socket.send(JSON.stringify({id,method,params}));
        }),
        sleep(120000).then(()=>{throw Error("CDP timeout "+method);})
      ]);
    },
    async evaluate(expression){
      const result=await this.send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});
      if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
      return result.result.value;
    },
    close(){socket.close();}
  };
}
let page;
try{
  const socket=await until(async()=>{
    const response=await fetch("http://127.0.0.1:"+port+"/json/list");
    return(await response.json()).find(x=>x.type==="page")?.webSocketDebuggerUrl;
  },"Chrome debug socket");
  page=await connect(socket);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Performance.enable");
  await page.send("Page.navigate",{url:base});
  await until(async()=>(await page.evaluate("document.querySelector('#status')?.textContent||''")).includes("Ready to paint"),"Hokusai load");

  await page.send("Emulation.setCPUThrottlingRate",{rate:cpuSlowdown});
  const expression=`(async()=>{
  const {PaintingEngine}=await import('./src/engine.js');
  const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=800;
  const engine=await PaintingEngine.create(canvas,()=>{});
  const rect={left:0,top:0,width:1200,height:800};
  const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
  const metrics={strokes:[],undo:[],redo:[],frames:[],points:0};
  let tick=1500;
  const stats=(values)=>{
    const a=values.slice().sort((x,y)=>x-y);
    return {min:a[0],median:a[Math.floor((a.length-1)*.5)],p95:a[Math.floor((a.length-1)*.95)],max:a[a.length-1],count:a.length};
  };
  const brushes=['pencil','charcoal','calligraphy','brush','marker_fat'];
  for(let n=0;n<300;n++){
    if(n%60===0)engine.configure({brushId:brushes[Math.floor(n/60)],size:0,eraser:false});
    const x=75+(n*59)%1000,y=60+(n*41)%650;
    tick+=20;
    const ev=(a,b)=>({clientX:a,clientY:b,pressure:1,pointerType:'mouse',timeStamp:tick});
    const start=performance.now();
    engine.begin(ev(x,y),rect);
    for(let i=1;i<=12;i++){
      tick+=11;
      engine.add(ev(x+i*2.4,y+Math.sin(i*.47+n*.13)*12),rect);
    }
    engine.end();
    metrics.points+=engine.history[n].points.length;
    metrics.strokes.push(performance.now()-start);
    if(n%30===29){
      const startFrame=performance.now();
      await frame();metrics.frames.push(performance.now()-startFrame);
    }
  }
  await frame();await frame();
  const checksum=async(context)=>{
    const bytes=context.getImageData(0,0,1200,800).data;
    const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
    return Array.from(digest,x=>x.toString(16).padStart(2,"0")).join("");
  };
  const baseline=await checksum(canvas.getContext('2d'));
  for(let i=0;i<8;i++){const t=performance.now();engine.undo();metrics.undo.push(performance.now()-t);}
  for(let i=0;i<8;i++){const t=performance.now();engine.redo();metrics.redo.push(performance.now()-t);}
  const tSave=performance.now(),saved=engine.snapshot(),snapshotMs=performance.now()-tSave;
  const canvas2=document.createElement('canvas');canvas2.width=1200;canvas2.height=800;
  const restored=await PaintingEngine.create(canvas2,()=>{});
  const tRestore=performance.now();restored.restoreArtwork(saved);
  const restoreMs=performance.now()-tRestore;
  const consistent=baseline===await checksum(canvas2.getContext('2d'));
  const result={
    browser:'Chromium',artwork:[1200,800],strokes:stats(metrics.strokes),
    undo:stats(metrics.undo),redo:stats(metrics.redo),frameWait:stats(metrics.frames),
    snapshotMs,restoreMs,checkpoints:engine.checkpoints.length,
    wasmMiB:Math.round(engine.wasm.memory.buffer.byteLength/1048576*10)/10,
    points:metrics.points,consistent
  };
  for(const item of [engine,restored]){
    item.releaseCheckpoints();item.active.free();item.surface.free();
  }
  return result;
})()`;
  const report=await page.evaluate(expression.replace("for(let n=0;n<300;n++){",
    "for(let n=0;n<"+strokeCount+";n++){"));
  report.cpuSlowdown=cpuSlowdown;
  report.strokesRequested=strokeCount;
  const measures=await page.send("Performance.getMetrics");
  const m=Object.fromEntries(measures.metrics.map(x=>[x.name,x.value]));
  report.jsHeapMiB=Math.round((m.JSHeapUsedSize||0)/1048576*10)/10;
  if(!report.consistent||report.strokes.count!==strokeCount||report.points<strokeCount*12||report.checkpoints<2)
    throw Error("Stress test failed correctness or volume: "+JSON.stringify(report));
  console.log("PERFORMANCE_REPORT "+JSON.stringify(report));
  const output=cpuSlowdown===1?"performance.json":"performance-cpu-"+cpuSlowdown+"x.json";
  await writeFile("test-artifacts/"+output,JSON.stringify(report,null,2)+"\n");
}catch(error){
  console.error("PERFORMANCE_FAILED",error.stack||error);
  process.exitCode=1;
}finally{
  page?.close();
  chrome.kill("SIGTERM");
  await sleep(200);
  await rm(dir,{recursive:true,force:true}).catch(()=>{});
}
