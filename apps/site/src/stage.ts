/** Inlined into the landing. No extra network. No WebGL. No always-on rAF. */
export const STAGE_SCRIPT = `(()=>{
var hero=document.querySelector('.hero');
var hit=document.querySelector('.stage-hit');
var live=document.querySelector('.stage-live');
var deck=document.querySelector('.deck');
var canvas=document.querySelector('canvas.stage');
if(!hero)return;
if(canvas)canvas.style.display='none';
var mq=window.matchMedia('(prefers-reduced-motion: reduce)');
var narrow=window.matchMedia('(max-width:820px)');
var ticking=0,moveTick=0,said=0,press=0,mx=0,my=0;
function say(s){if(live)live.textContent=s}
function quiet(){return mq.matches||narrow.matches}
function bindOf(){
  var reel=document.querySelector('.reel');
  var max,y;
  if(reel){
    max=Math.max(1,reel.offsetHeight-innerHeight);
    y=(window.scrollY||document.documentElement.scrollTop||0)-reel.offsetTop;
  }else{
    max=Math.max(1,(document.documentElement.scrollHeight||0)-innerHeight);
    y=window.scrollY||document.documentElement.scrollTop||0;
  }
  var b=y/max;
  if(b<0)b=0;else if(b>1)b=1;
  return b;
}
function pose(b){
  if(!deck)return;
  if(quiet()||press){
    if(quiet())deck.style.transform='none';
    return;
  }
  deck.style.transform='rotateX('+(-12+b*3).toFixed(2)+'deg) rotateY('+(-8+b*2).toFixed(2)+'deg) rotateZ('+(2-b).toFixed(2)+'deg) scale(0.92)';
}
function apply(b){
  hero.style.setProperty('--bind',b.toFixed(3));
  var one=b>0.72;
  hero.classList.toggle('is-one',one);
  if(deck)deck.classList.toggle('is-one',one);
  if(hit)hit.setAttribute('aria-pressed',one?'true':'false');
  pose(b);
  if((one?1:0)!==said){said=one?1:0;say(one?'One remains.':'Repeated work.')}
}
function onScroll(){
  if(ticking)return;
  ticking=1;
  requestAnimationFrame(function(){ticking=0;apply(bindOf())});
}
function paintMove(){
  moveTick=0;
  if(!deck||quiet())return;
  var el=hit||hero;
  var r=el.getBoundingClientRect();
  var x=(mx-r.left)/Math.max(r.width,1)-0.5;
  var y=(my-r.top)/Math.max(r.height,1)-0.5;
  var k=press?1.05:0.45;
  var b=bindOf();
  deck.style.transform='rotateX('+(-12+b*3-y*12*k).toFixed(2)+'deg) rotateY('+(-8+b*2+x*12*k).toFixed(2)+'deg) rotateZ('+(2-b+x*2*k).toFixed(2)+'deg) scale(0.92)';
}
function onMove(e){
  if(!deck||quiet())return;
  mx=e.clientX;my=e.clientY;
  if(moveTick)return;
  moveTick=1;
  requestAnimationFrame(paintMove);
}
if(hit){
  hit.addEventListener('pointerdown',function(e){
    press=1;
    if(hit.setPointerCapture)try{hit.setPointerCapture(e.pointerId)}catch(x){}
    onMove(e);
  });
  hit.addEventListener('pointermove',onMove);
  hit.addEventListener('pointerup',function(){press=0;pose(bindOf())});
  hit.addEventListener('pointercancel',function(){press=0;pose(bindOf())});
}
window.addEventListener('scroll',onScroll,{passive:true});
window.addEventListener('resize',onScroll,{passive:true});
mq.addEventListener&&mq.addEventListener('change',function(){apply(bindOf())});
narrow.addEventListener&&narrow.addEventListener('change',function(){apply(bindOf())});
say('Repeated work.');
apply(bindOf());
})();`;
