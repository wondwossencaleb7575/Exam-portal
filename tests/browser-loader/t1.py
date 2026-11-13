import asyncio, json, re
from playwright.async_api import async_playwright
from harness import *
from t1_helpers import waitjs
R=[]   # (name, ok, detail)
def rec(n,ok,d=''): R.append((n,bool(ok),d)); print(('PASS' if ok else 'FAIL'),n,d,flush=True)

# page-side probes installed before any script runs
PROBE="""
window.__p={maxOp:0,cls:0,shownAt:null,hiddenAt:null,msgs:[],t0:performance.now()};
new PerformanceObserver(l=>{for(const e of l.getEntries()) if(!e.hadRecentInput) window.__p.cls+=e.value}).observe({type:'layout-shift',buffered:true});
(function tick(){const el=document.getElementById('eagle-loader');
 if(el){const op=parseFloat(getComputedStyle(el).opacity), vis=!el.hidden&&getComputedStyle(el).display!=='none';
  if(vis){window.__p.maxOp=Math.max(window.__p.maxOp,op); if(op>0.05&&window.__p.shownAt===null)window.__p.shownAt=performance.now()-window.__p.t0;}
  if(!vis&&window.__p.hiddenAt===null&&window.__p.t0)window.__p.hiddenAt=performance.now()-window.__p.t0;
  const m=el.querySelector('.el-msg').textContent; const l=window.__p.msgs; if(vis&&l[l.length-1]!==m)l.push(m);}
 requestAnimationFrame(tick)})();
"""
async def newpage(b,**kw):
    ctx=await b.new_context(viewport={'width':1280,'height':800},**kw); pg=await ctx.new_page()
    errs=[]; pg.on('console',lambda m: errs.append(m.text) if m.type in('error','warning') else None); pg.on('pageerror',lambda e: errs.append(str(e)))
    await pg.add_init_script(PROBE); pg.errs=errs; return pg
async def login(pg,who):
    await pg.goto(URL+'/#/login'); await pg.wait_for_selector('#em'); await waitjs(pg,'!EagleLoader.isOn()'); await pg.fill('#em',who+'@x'); await pg.fill('#pw','pw'); await pg.click('#f button[type=submit]')
async def P(pg): return await pg.evaluate('window.__p')
async def main():
  with mock():
    async with async_playwright() as p:
      b=await p.chromium.launch()
      # ---------- 1. slow first load
      cfg(delay={'/api/auth/me':2600}); pg=await newpage(b)
      await pg.goto(URL+'/',wait_until='commit'); await pg.wait_for_timeout(900)
      vis=await pg.evaluate("!document.getElementById('eagle-loader').hidden")
      rec('first load (slow): loader visible while /me is pending',vis)
      # wings really animate: sample transforms
      s=[]; 
      for _ in range(6):
          s.append(await pg.evaluate("[getComputedStyle(document.querySelector('.el-wa')).transform,getComputedStyle(document.querySelector('.el-wb')).transform,getComputedStyle(document.querySelector('.el-flight')).transform]")); await pg.wait_for_timeout(130)
      rec('wing layers animate independently (A, B, body bob all change over time)', len({x[0] for x in s})>3 and len({x[1] for x in s})>3 and len({x[2] for x in s})>3, f'{len({x[0] for x in s})}/{len({x[1] for x in s})}/{len({x[2] for x in s})} distinct matrices of 6')
      await pg.wait_for_selector('.wc',timeout=8000); await pg.wait_for_timeout(900)
      pr=await P(pg); hid=await pg.evaluate("document.getElementById('eagle-loader').hidden")
      rec('first load (slow): welcome page revealed and loader removed',hid)
      rec('first load: no layout shift (CLS)',pr['cls']<0.01,f"CLS={pr['cls']:.4f}")
      rec('first load: no console/CSP errors',not pg.errs,str(pg.errs))
      rec('first load: root is no longer inert / page usable',await pg.evaluate("!document.getElementById('root').hasAttribute('inert')"))
      # ---------- 2. fast load: never flashes
      cfg(); pg2=await newpage(b); await pg2.goto(URL+'/'); await pg2.wait_for_selector('.wc'); await pg2.wait_for_timeout(700); pr=await P(pg2)
      rec('fast load (<120ms of real loading): loader never becomes visible (no flash)',pr['maxOp']<0.05,f"max opacity seen={pr['maxOp']:.3f}")
      # ---------- 3. student login -> dashboard (first = full, second = skeleton only)
      cfg(delay={'/api/student/exams':1800}); pg=await newpage(b); await login(pg,'student')
      await pg.wait_for_timeout(1000)
      rec('student: full-screen loader after sign-in',await pg.evaluate("EagleLoader.isOn()&&!document.getElementById('eagle-loader').hidden"))
      rec('student: message is "Loading your dashboard..."',(await pg.inner_text('.el-msg'))=='Loading your dashboard...',await pg.inner_text('.el-msg'))
      await pg.wait_for_selector('h1:has-text("My exams")',timeout=8000); await pg.wait_for_timeout(1000); pr=await P(pg)
      rec('student: dashboard revealed, loader gone',await pg.evaluate("document.getElementById('eagle-loader').hidden"))
      rec('student: message tracks the real load (no invented stages on a 1.8s load)',pr['msgs'][-1]=='Loading your dashboard...' ,str(pr['msgs']))
      await pg.evaluate("location.hash='#/s/exam/1'"); await pg.wait_for_selector('#go'); await pg.evaluate("location.hash='#/s'"); await pg.wait_for_selector('h1:has-text("My exams")')
      rec('student: returning to dashboard in same session uses skeleton, not the eagle',await pg.evaluate("!EagleLoader.isOn()"))
      # ---------- 4. exam initialisation
      cfg(delay={'/api/student/attempts/7':1500,'/start':900}); await pg.evaluate("location.hash='#/s/exam/1'"); await pg.wait_for_selector('#go')
      rec('exam instructions page: no full-screen loader (ordinary load)',await pg.evaluate("!EagleLoader.isOn()"))
      await pg.click('#go'); await pg.wait_for_timeout(400)
      rec('exam: loader appears while the attempt is being created',await pg.evaluate("EagleLoader.isOn()"))
      await pg.wait_for_selector('.xwrap',timeout=9000); await pg.wait_for_timeout(1000)
      rec('exam: player shown, loader removed',await pg.evaluate("document.getElementById('eagle-loader').hidden && !!document.querySelector('.xwrap')"))
      cfg()  # injected latency was only for exam preparation
      rec('exam: loader REFUSES to start over a live exam',await pg.evaluate("EagleLoader.begin('exam')===false && EagleLoader.begin('dash')===false && !EagleLoader.isOn()"))
      await pg.click('input[type=radio]')
      await pg.wait_for_timeout(3000)
      h=hits(); put=h.get('PUT /api/student/attempts/7/answers',0)
      settled=await pg.evaluate("document.querySelector('#sv').textContent.includes('All answers saved')")
      rec('exam: answer autosaved to the server while player is active (loader did not interfere)',put>=1 and settled,f'PUT answers x{put}, badge="{await pg.inner_text("#sv")}"')
      # refresh in middle of exam
      cfg(delay={'/api/student/attempts/7':1200}); await pg.reload(); await pg.wait_for_timeout(700)
      rec('exam: refresh shows loader while exam is re-prepared',await pg.evaluate("EagleLoader.isOn()"))
      await pg.wait_for_selector('.xwrap',timeout=9000); await pg.wait_for_timeout(900)
      kept=await pg.evaluate("document.querySelector('input[type=radio]:checked')!==null")
      rec('exam: refresh keeps the previously saved answer / player resumes',kept)
      rec('exam: no console errors across the flow',not pg.errs,str(pg.errs))
      # ---------- 5. teacher dashboard
      cfg(delay={'/api/dashboard':1500}); pg=await newpage(b); await login(pg,'teacher'); await pg.wait_for_timeout(900)
      rec('teacher: full-screen loader after sign-in',await pg.evaluate("EagleLoader.isOn()"))
      await pg.wait_for_selector('h1:has-text("Dashboard")',timeout=8000); await pg.wait_for_timeout(900)
      rec('teacher: dashboard revealed',await pg.evaluate("document.getElementById('eagle-loader').hidden"))
      rec('teacher: no console errors',not pg.errs,str(pg.errs))
      # ---------- 6. admin dashboard keeps loader until its own table data arrives
      cfg(delay={'/api/admin/users':1800}); pg=await newpage(b); await login(pg,'admin'); await pg.wait_for_selector('main#main',timeout=5000); await pg.wait_for_timeout(1300)
      rec('admin: loader still up while the users table is still loading (page frame already drawn)',await pg.evaluate("EagleLoader.isOn() && !document.querySelector('table')"))
      await pg.wait_for_selector('table',timeout=8000); await pg.wait_for_timeout(1000)
      rec('admin: loader removed once table is on screen',await pg.evaluate("document.getElementById('eagle-loader').hidden"))
      # ---------- 7. refresh while signed in
      cfg(delay={'/api/auth/me':900,'/api/admin/users':600}); await pg.reload(); await pg.wait_for_timeout(500)
      rec('browser refresh: loader shows again on start-up',await pg.evaluate("EagleLoader.isOn()"))
      await pg.wait_for_selector('table',timeout=8000); await pg.wait_for_timeout(900)
      rec('browser refresh: ends on the dashboard, loader gone',await pg.evaluate("document.getElementById('eagle-loader').hidden"))
      rec('admin: no console errors',not pg.errs,str(pg.errs))
      await b.close()
  ok=sum(1 for r in R if r[1]); print(f'\n{ok}/{len(R)} passed'); json.dump(R,open('results_t1.json','w'))
asyncio.run(main())
