// usage: node compose.js OUTDIR f0 f1   (or: node compose.js OUTDIR list f,f,f)
const { chromium } = require('playwright'); const fs=require('fs');
const [out,a,b]=process.argv.slice(2); fs.mkdirSync(out,{recursive:true});
(async()=>{ const br=await chromium.launch(); const p=await br.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:4/3});
 p.on('pageerror',e=>console.log('ERR',e.message));
 await p.goto('http://127.0.0.1:8785/comp.html'); await p.waitForFunction(()=>window.READY===true);
 const list=a==='list'? b.split(',').map(Number) : Array.from({length:+b-+a},(_,i)=>+a+i);
 for(const f of list){ await p.evaluate(f=>window.renderAt(f),f); await p.screenshot({path:`${out}/${String(f).padStart(4,'0')}.png`}); }
 await br.close(); })();
