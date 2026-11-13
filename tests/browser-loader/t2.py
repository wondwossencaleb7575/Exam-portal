import asyncio, json, os
os.makedirs('shots', exist_ok=True)
from playwright.async_api import async_playwright
from harness import *
from t1_helpers import *
ST="""(()=>{const e=document.getElementById('eagle-loader');return {state:e.dataset.state,hidden:e.hidden,txt:e.querySelector('.el-etxt').textContent,
 wing:getComputedStyle(e.querySelector('.el-wa')).animationName,body:getComputedStyle(e.querySelector('.el-flight')).animationName,
 retry:!e.querySelector('.el-retry').hidden,dismiss:!e.querySelector('.el-dismiss').hidden,inert:document.getElementById('root').hasAttribute('inert')}})()"""
async def main():
  with mock():
    async with async_playwright() as p:
      b=await p.chromium.launch()
      # --- race: new load arrives while the screen is mid fade-out
      cfg(); pg=await newpage(b); await pg.goto(URL+'/#/login'); await pg.wait_for_selector('#em'); await waitjs(pg,'!EagleLoader.isOn()')
      await pg.evaluate("EagleLoader.begin('dash')"); await pg.wait_for_timeout(800); await pg.evaluate("EagleLoader.done()")
      await waitjs(pg,"document.getElementById('eagle-loader').classList.contains('is-out')",timeout=4000)
      await pg.evaluate("EagleLoader.begin('dash')"); await pg.wait_for_timeout(700)
      s=await pg.evaluate("({out:document.getElementById('eagle-loader').classList.contains('is-out'),op:parseFloat(getComputedStyle(document.getElementById('eagle-loader')).opacity),on:EagleLoader.isOn(),inert:document.getElementById('root').hasAttribute('inert')})")
      rec('race: begin() during fade-out brings the screen back (visible, not stuck invisible-but-inert)',(not s['out']) and s['op']>0.9 and s['on'] and s['inert'],str(s))
      await pg.evaluate("EagleLoader.done()"); await pg.wait_for_timeout(1400)
      rec('race: ...and it still ends cleanly afterwards',await pg.evaluate("document.getElementById('eagle-loader').hidden && !document.getElementById('root').hasAttribute('inert')"))
      # --- 'Almost ready' appears only when a visible screen is held for its minimum time
      await pg.evaluate("EagleLoader.begin('dash')"); await pg.wait_for_timeout(300); await pg.evaluate("EagleLoader.done()")
      rec('"Almost ready..." shown while a just-appeared screen is held for its minimum time',(await pg.inner_text('.el-msg'))=='Almost ready...',await pg.inner_text('.el-msg'))
      await pg.wait_for_timeout(1300)
      # --- server unreachable at start-up (HTTP 500)
      cfg(fail={'/api/auth/me':500}); pg=await newpage(b); await pg.goto(URL+'/'); await pg.wait_for_timeout(1500); s=await pg.evaluate(ST)
      rec('boot 500: error shown on the loader, NOT a success transition',s['state']=='error' and not s['hidden'],str(s))
      rec('boot 500: flying animation stopped (rest pose), Try again offered',s['wing']=='none' and s['body']=='none' and s['retry'])
      rec('boot 500: page behind stays inert (cannot be used half-initialised)',s['inert'])
      await pg.screenshot(path='shots/fail_boot.png')
      cfg(); await pg.click('.el-retry'); await pg.wait_for_selector('.wc',timeout=6000); await pg.wait_for_timeout(1200)
      rec('boot 500: Try again recovers and reveals the app',await pg.evaluate("document.getElementById('eagle-loader').hidden && !document.getElementById('root').hasAttribute('inert')"))
      # --- connection dropped at start-up
      cfg(fail={'/api/auth/me':'drop'}); pg=await newpage(b); await pg.goto(URL+'/'); await pg.wait_for_timeout(2500); s=await pg.evaluate(ST)
      rec('boot network failure: error state, not "signed out"',s['state']=='error' and not s['hidden'],s['txt'])
      cfg(fail={'/api/auth/me':'drop'}); await pg.click('.el-dismiss'); await pg.wait_for_timeout(600)
      rec('boot network failure: "Open sign-in page" works as an explicit user choice',await pg.evaluate("document.getElementById('eagle-loader').hidden")) 
      # --- dashboard API fails (student)
      cfg(fail={'/api/student/exams':500}); pg=await newpage(b); await login(pg,'student'); await pg.wait_for_timeout(1800); s=await pg.evaluate(ST)
      rec('student dashboard 500: error on the loader (nothing fades out as success)',s['state']=='error' and not s['hidden'],s['txt'])
      await pg.click('.el-dismiss'); await pg.wait_for_timeout(700)
      rec('student dashboard 500: "Show details" reveals the normal error page with sign-out available',await pg.evaluate("document.getElementById('eagle-loader').hidden && !!document.querySelector('#rt') && !!document.querySelector('#lo')"))
      cfg(); await pg.click('#rt'); await pg.wait_for_selector('h1:has-text("My exams")',timeout=6000)
      rec('student dashboard 500: Try again then loads the dashboard',True)
      # --- teacher dashboard fails then retry from loader
      cfg(fail={'/api/dashboard':500}); pg=await newpage(b); await login(pg,'teacher'); await pg.wait_for_timeout(1800)
      rec('teacher dashboard 500: error on loader',(await pg.evaluate(ST))['state']=='error')
      cfg(); await pg.click('.el-retry'); await pg.wait_for_selector('h1:has-text("Dashboard")',timeout=6000); await pg.wait_for_timeout(1200)
      rec('teacher dashboard: Try again on the loader recovers and reveals dashboard',await pg.evaluate("document.getElementById('eagle-loader').hidden"))
      # --- admin first table load fails
      cfg(fail={'/api/admin/users':500}); pg=await newpage(b); await login(pg,'admin'); await pg.wait_for_timeout(2000)
      rec('admin users 500: loader shows error instead of revealing an empty page',(await pg.evaluate(ST))['state']=='error')
      # --- exam start refused: student must not get stuck
      cfg(fail={'/start':500}); pg=await newpage(b); await login(pg,'student'); await pg.wait_for_selector('h1:has-text("My exams")'); await pg.wait_for_timeout(1000)
      await pg.evaluate("location.hash='#/s/exam/1'"); await pg.wait_for_selector('#go'); await pg.click('#go'); await pg.wait_for_timeout(1800)
      rec('exam start 500: loader leaves, error message shown, Start button usable again',await pg.evaluate("document.getElementById('eagle-loader').hidden && !document.getElementById('er').hidden && !document.getElementById('go').disabled"))
      # --- exam fetch fails: error on loader, nothing half-loaded
      cfg(fail={'/api/student/attempts/7':500}); await pg.evaluate("location.hash='#/s/attempt/7'"); await pg.wait_for_timeout(1500)
      rec('exam prepare 500: error on loader, no player mounted',(await pg.evaluate(ST))['state']=='error' and await pg.evaluate("!document.querySelector('.xwrap')"))
      # --- slow connection: honest messages, soft message at 15s, hard time-out at 40s -> error (never infinite)
      cfg(delay={'/api/auth/me':70000}); pg=await newpage(b); await pg.goto(URL+'/',wait_until='commit'); seen=[]
      for t in (1000,4500,16000):
          await pg.wait_for_timeout(t-(seen[-1][0] if seen else 0)); seen.append((t,await pg.inner_text('.el-msg')))
      rec('slow network: messages follow elapsed real time (sync at 3.5s, slow-connection notice at 15s)',seen[0][1].startswith('Preparing') and seen[1][1].startswith('Synchronizing') and 'longer than usual' in seen[2][1],str(seen))
      await pg.wait_for_timeout(25500); s=await pg.evaluate(ST)
      rec('slow network: hard time-out at 40s turns into an error with retry (no infinite loading)',s['state']=='error' and s['retry'],s['txt'])
      await b.close()
  ok=sum(1 for r in R if r[1]); print(f'\n{ok}/{len(R)} passed'); json.dump(R,open('results_t2.json','w'))
asyncio.run(main())
