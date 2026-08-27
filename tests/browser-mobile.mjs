import { chromium } from 'playwright';
const b = await chromium.launch();
const pages = ['/','/plants/','/tokyo/','/croissants/','/italian/','/research/'];
let bad = 0;
for (const path of pages) {
  const ctx = await b.newContext({ viewport:{width:375,height:800}, isMobile:true, hasTouch:true });
  const page = await ctx.newPage();
  await page.route('**/api/weather*', r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,
    current:{temperature_2m:31,weather_code:2,relative_humidity_2m:70,apparent_temperature:35,precipitation:0,wind_speed_10m:12,is_day:1},
    daily:{time:['2026-08-27','2026-08-28','2026-08-29'],weather_code:[2,3,61],temperature_2m_max:[34,33,29],temperature_2m_min:[26,25,24],
      precipitation_sum:[0,0.2,12],precipitation_probability_max:[10,20,80],wind_speed_10m_max:[18,20,35],uv_index_max:[9,8,5],sunrise:['x'],sunset:['y']},
    hourly:{time:Array.from({length:24},(_,i)=>`2026-08-27T${String(i).padStart(2,'0')}:00`),temperature_2m:Array.from({length:24},(_,i)=>26+i%8),
      precipitation_probability:Array(24).fill(10),weather_code:Array(24).fill(2)},
    advisories:[{key:'heat',severity:'high',value:34}]})}));
  await page.route('**/api/news*', r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,lang:'en',sources:['NHK'],
    fetchedAt:new Date().toISOString(),items:[{title:'A fairly long Tokyo headline that should wrap rather than overflow the viewport',link:'https://e.com',summary:'Summary text.',publishedAt:new Date().toISOString(),source:'NHK'}]})}));
  await page.route('**/api/store*', r=>r.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"database":false,"authRequired":false,"records":[]}'}));
  await page.goto('http://127.0.0.1:8899'+path,{waitUntil:'networkidle'});
  await page.waitForTimeout(900);
  const r = await page.evaluate(()=>{
    const de=document.documentElement;
    const overflow = de.scrollWidth - de.clientWidth;
    const wide=[];
    document.querySelectorAll('body *').forEach(el=>{
      const rect=el.getBoundingClientRect();
      if(rect.width>0 && rect.right > de.clientWidth+1){
        const cs=getComputedStyle(el);
        // Elements inside their own scroll container are fine.
        let p=el.parentElement, contained=false;
        while(p){const pc=getComputedStyle(p); if(/auto|scroll/.test(pc.overflowX)){contained=true;break;} p=p.parentElement;}
        if(!contained) wide.push(el.tagName+'.'+(el.className||'').toString().split(' ')[0]+' right='+Math.round(rect.right));
      }
    });
    return {overflow, wide:[...new Set(wide)].slice(0,5)};
  });
  const ok = r.overflow<=1 && r.wide.length===0;
  if(!ok) bad++;
  console.log(`${ok?'✓':'✗'} ${path} overflow=${r.overflow}px ${r.wide.length?JSON.stringify(r.wide):''}`);
  await ctx.close();
}
await b.close();
console.log(bad?`\n${bad} page(s) overflow on mobile`:'\nNo horizontal overflow at 375px');
process.exit(bad?1:0);
