// usage: node frender.js SHOT OUTDIR mode args...   mode=times t1,t2,..  | mode=frames f0 f1 (24fps, inclusive-exclusive)
const { chromium } = require('playwright');
const [shot,out,mode,a,b]=process.argv.slice(2); const fs=require('fs'); fs.mkdirSync(out,{recursive:true});
(async()=>{ const br=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']}); const p=await br.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:4/3});
 p.on('pageerror',e=>console.log('ERR',e.message));
 await p.goto('http://127.0.0.1:8785/film2.html?shot='+shot); await p.waitForFunction(()=>window.READY===true,{timeout:300000});
 const jobs= mode==='times'? a.split(',').map(Number).map(t=>({t,name:`${shot}_${t.toFixed(2)}`})) : Array.from({length:+b-+a},(_,i)=>({t:(+a+i)/24,name:String(+a+i).padStart(4,'0')}));
 for(const j of jobs){ const t0=Date.now(); await p.evaluate(t=>window.renderAt(t),j.t); await p.screenshot({path:`${out}/${j.name}.png`,timeout:180000}); if(mode==='times'||(+j.name%24===0)) console.log(shot,j.name,Date.now()-t0,'ms'); }
 await br.close(); })();
