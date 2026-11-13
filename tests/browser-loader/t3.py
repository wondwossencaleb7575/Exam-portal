import asyncio, json, os
os.makedirs('shots', exist_ok=True)
from playwright.async_api import async_playwright
from harness import *
from t1_helpers import *
async def main():
  with mock():
    async with async_playwright() as p:
      b=await p.chromium.launch()
      # ---- mobile
      cfg(delay={'/api/auth/me':2500})
      for name,(w,h) in {'iphone-se':(375,667),'small-android':(360,640),'tablet':(768,1024)}.items():
          pg=await newpage(b,w,h,is_mobile=True,has_touch=True); await pg.goto(URL+'/',wait_until='commit'); await pg.wait_for_timeout(1500)
          m=await pg.evaluate("(()=>{const e=document.getElementById('eagle-loader'),r=e.getBoundingClientRect(),g=document.querySelector('.el-eagle').getBoundingClientRect(),t=document.querySelector('.el-msg').getBoundingClientRect();return {w:r.width,h:r.height,eagleW:Math.round(g.width),sx:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,msgInside:t.left>=0&&t.right<=innerWidth}})()")
          rec(f'mobile {name} {w}x{h}: loader fills screen, no horizontal overflow, text inside viewport',m['w']==w and m['h']==h and m['sx']<=m['cw'] and m['msgInside'],str(m))
          if name=='iphone-se': await pg.screenshot(path='shots/mobile.png')
      # ---- reduced motion
      cfg(delay={'/api/auth/me':1500}); ctx=await b.new_context(viewport={'width':1280,'height':800},reduced_motion='reduce'); pg=await ctx.new_page()
      await pg.goto(URL+'/',wait_until='commit'); await pg.wait_for_timeout(900)
      a=await pg.evaluate("(()=>{const q=s=>getComputedStyle(document.querySelector(s));return {wa:q('.el-wa').animationName,wb:q('.el-wb').animationName,fl:q('.el-flight').animationName,tr:q('.el-track i').animationName,trW:Math.round(parseFloat(q('.el-track i').width)),trackW:Math.round(parseFloat(q('.el-track').width)),sky:q('.el-sky').display,vis:!document.getElementById('eagle-loader').hidden,msg:document.querySelector('.el-msg').textContent}})()")
      rec('reduced motion: no flying/flapping/track animation, logo is shown still, no moving wind lines',a['wa']=='none' and a['wb']=='none' and a['fl']=='none' and a['tr']=='none' and a['sky']=='none' and a['vis'],str(a))
      rec('reduced motion: indicator is a still full line (cannot be mistaken for a percentage)',a['trW']==a['trackW'])
      await pg.screenshot(path='shots/reduced.png')
      await pg.wait_for_timeout(1500)
      rec('reduced motion: app still loads and loader is removed',await pg.evaluate("document.getElementById('eagle-loader').hidden"))
      # reduced motion exits immediately, no 500ms hold
      cfg(delay={'/api/student/exams':700}); pg2=await (await b.new_context(viewport={'width':1280,'height':800},reduced_motion='reduce')).new_page(); await login(pg2,'student')
      await pg2.evaluate("window.__t=performance.now()"); await waitjs(pg2,"!!document.querySelector('h1') && document.querySelector('h1').textContent.includes('My exams')"); await pg2.wait_for_timeout(120)
      rec('reduced motion: page not held back by the minimum-visible time',await pg2.evaluate("document.getElementById('eagle-loader').hidden"))
      # ---- accessibility attributes
      pg=await newpage(b); cfg(delay={'/api/auth/me':1500}); await pg.goto(URL+'/',wait_until='commit'); await pg.wait_for_timeout(500)
      a=await pg.evaluate("(()=>{const e=document.getElementById('eagle-loader');return {role:e.getAttribute('role'),live:e.getAttribute('aria-live'),busy:e.getAttribute('aria-busy'),imgsAlt:[...e.querySelectorAll('img')].every(i=>i.alt===''),decorHidden:e.querySelector('.el-stage').getAttribute('aria-hidden')==='true',inert:document.getElementById('root').hasAttribute('inert')}})()")
      rec('a11y: status role, polite live region, aria-busy, decorative eagle hidden from screen readers, page behind inert',a['role']=='status' and a['live']=='polite' and a['busy']=='true' and a['imgsAlt'] and a['decorHidden'] and a['inert'],str(a))
      await pg.wait_for_timeout(2500)
      rec('a11y: aria-busy cleared and inert removed after load',await pg.evaluate("document.getElementById('eagle-loader').getAttribute('aria-busy')==='false' && !document.getElementById('root').hasAttribute('inert')"))
      # ---- no-JS fallback
      ctx=await b.new_context(java_script_enabled=False); pg=await ctx.new_page(); await pg.goto(URL+'/'); 
      rec('no JavaScript: splash is hidden by <noscript> rule (page is not covered forever)',await pg.evaluate("getComputedStyle(document.getElementById('eagle-loader')).display")=='none')
      # ---- CPU: main-thread work while the animation runs for 4s
      cfg(delay={'/api/auth/me':6000}); pg=await newpage(b); cdp=await pg.context.new_cdp_session(pg); await cdp.send('Performance.enable')
      await pg.goto(URL+'/',wait_until='commit'); await pg.wait_for_timeout(1500)
      m0={x['name']:x['value'] for x in (await cdp.send('Performance.getMetrics'))['metrics']}; await pg.wait_for_timeout(4000)
      m1={x['name']:x['value'] for x in (await cdp.send('Performance.getMetrics'))['metrics']}
      busy=(m1['TaskDuration']-m0['TaskDuration'])/4*100; script=(m1['ScriptDuration']-m0['ScriptDuration'])/4*100; layout=(m1['LayoutDuration']-m0['LayoutDuration'])/4*100
      rec('CPU: main thread nearly idle during the animation (it runs on the compositor)',busy<8,f'main-thread busy {busy:.1f}% (script {script:.2f}%, layout {layout:.2f}%) over 4s, software-rendered headless')
      fps=await pg.evaluate("new Promise(r=>{let n=0,t=performance.now();(function f(){n++;if(performance.now()-t>2000)r(n/2);else requestAnimationFrame(f)})()})")
      rec('smoothness: page produces frames steadily while animating (headless software renderer)',fps>=30,f'{fps:.0f} rAF frames/s')
      # ---- payload
      sizes=await pg.evaluate("performance.getEntriesByType('resource').filter(e=>/eagle|loader/.test(e.name)).map(e=>[e.name.split('/').pop(),e.transferSize])")
      tot=sum(s for _,s in sizes); rec('payload: eagle layers + loader JS/CSS',tot<90000,f'{tot/1024:.1f} KB transferred: {sizes}')
      await b.close()
      # ---- other engines (if installed)
      for eng in ('firefox','webkit'):
          try:
              br=await getattr(p,eng).launch(); pg=await newpage(br); cfg(delay={'/api/auth/me':2000}); await pg.goto(URL+'/',wait_until='commit'); await pg.wait_for_timeout(1200)
              v=await pg.evaluate("!document.getElementById('eagle-loader').hidden && getComputedStyle(document.querySelector('.el-wa')).animationName"); await pg.wait_for_selector('.wc',timeout=8000); await pg.wait_for_timeout(1000)
              h=await pg.evaluate("document.getElementById('eagle-loader').hidden"); rec(f'{eng}: loader animates then reveals the app',bool(v) and v!='none' and h,str(pg.errs)); await br.close()
          except Exception as e: print('SKIP',eng,str(e).splitlines()[0][:120])
  ok=sum(1 for r in R if r[1]); print(f'\n{ok}/{len(R)} passed'); json.dump(R,open('results_t3.json','w'))
asyncio.run(main())
