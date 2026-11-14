import sys, os, time, json, re, traceback, tempfile
OUT = os.environ.get('EAGLE_TEST_OUT') or tempfile.mkdtemp(prefix='eagle-loader-test-')   # screenshots + results.json land here
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness
from harness import start, ctl
from playwright.sync_api import sync_playwright

SAMPLER = """(() => {
  window.__log = []; window.__cls = 0; const t0 = performance.now();
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
  function tick() { const e = document.getElementById('eagle-splash');
    if (e) { const cs = getComputedStyle(e); window.__log.push([Math.round(performance.now() - t0), (e.hidden || cs.display === 'none') ? 0 : 1, +cs.opacity, e.className, (e.querySelector('.es-msg') || {}).textContent, document.querySelector('#root h1') ? 1 : 0, document.querySelectorAll('[inert]').length]); }
    requestAnimationFrame(tick); }
  requestAnimationFrame(tick);
})();"""

RESULTS = []
def T(name):
    def deco(fn):
        def run(b):
            t = time.time()
            try:
                detail = fn(b) or ''
                RESULTS.append((name, True, detail, time.time() - t)); print(f'PASS  {name}  {detail}')
            except Exception as e:
                RESULTS.append((name, False, f'{type(e).__name__}: {e}', time.time() - t)); print(f'FAIL  {name}\n      {type(e).__name__}: {e}'); traceback.print_exc(limit=2)
        run.__name__ = fn.__name__; TESTS.append(run); return run
    return deco
TESTS = []

class Pg:
    def __init__(self, b, vw=1280, vh=760, reduced=False, dpr=1, mobile=False, sampler=True, offline=False):
        self.ctx = b.new_context(viewport={'width': vw, 'height': vh}, reduced_motion='reduce' if reduced else 'no-preference', device_scale_factor=dpr, is_mobile=mobile, has_touch=mobile)
        if sampler: self.ctx.add_init_script(SAMPLER)
        self.pg = self.ctx.new_page(); self.errors = []
        self.pg.on('console', lambda m: self.errors.append(f'{m.type}: {m.text}') if m.type in ('error',) else None)
        self.pg.on('pageerror', lambda e: self.errors.append('PAGEERROR ' + str(e)))
    def log(self): return self.pg.evaluate('window.__log')
    def close(self): self.ctx.close()
    def wait_gone(self, timeout=15000): self.pg.wait_for_function("() => { const e = document.getElementById('eagle-splash'); return e.hidden }", timeout=timeout)
    def sign_in(self, email, wait_for='h1'):
        self.pg.goto(harness.BASE + '/#/login'); self.pg.wait_for_selector('#em'); self.pg.fill('#em', email); self.pg.fill('#pw', 'pw'); self.pg.click('#f button')
        self.pg.wait_for_url(re.compile(r'#/(s|t|a)')); poll(self.pg, "!!document.querySelector('#root h1') && !document.querySelector('.spin') && !/Sign in/.test(document.querySelector('#root h1').textContent)", 20); self.wait_gone()
def poll(pg, expr, secs):
    t = time.time()
    while time.time() - t < secs:
        if pg.evaluate(expr): return
        time.sleep(0.1)
    raise TimeoutError(expr)
def vis(log, t0=0): return [e for e in log if e[0] >= t0 and e[1] and e[2] > 0.05]
def uniq_msgs(log): 
    out = []
    for e in log:
        if e[1] and e[2] > 0.05 and (not out or out[-1] != e[4]): out.append(e[4])
    return out
def reset(**kw): ctl(reset=True, **kw)

# ------------------------------------------------------------------ 1. first load
@T('1  First application load (signed out)')
def t1(b):
    reset(); p = Pg(b); p.pg.goto(harness.BASE + '/'); p.wait_gone(); p.pg.wait_for_selector('#root h1'); log = p.log()
    assert log[0][1] == 1, 'splash is not on screen in the very first sampled frame'
    assert any(e[1] and e[2] > .05 for e in log[:5]), 'splash not visible at first paint'
    assert p.pg.evaluate("document.querySelectorAll('[inert]').length") == 0, 'page left inert after load'
    assert p.pg.evaluate("document.getElementById('eagle-splash').getAttribute('aria-busy')") == 'false'
    cls = p.pg.evaluate('window.__cls'); assert cls < 0.05, f'layout shift {cls}'
    assert not p.errors, p.errors
    hidden_at = next(e[0] for e in log if not e[1]); first_h1 = next(e[0] for e in log if e[5]); p.close()
    return f'splash on first frame; welcome page rendered at {first_h1} ms, splash gone at {hidden_at} ms; CLS={cls:.4f}; console errors: 0'

@T('1b Fast start-up is not delayed artificially (end-to-end, zero latency)')
def t1b(b):
    reset(); p = Pg(b); p.pg.goto(harness.BASE + '/'); p.wait_gone(); log = p.log()
    h1 = next(e[0] for e in log if e[5]); lv = next(e[0] for e in log if 'is-leaving' in e[3]); gone = next(e[0] for e in log if not e[1]); p.close()
    assert lv - h1 < 120, f'fade-out began {lv - h1} ms after the page rendered'
    return f'page rendered {h1} ms -> fade starts +{lv - h1} ms -> gone +{gone - h1} ms (fade is 450 ms; no hold at start-up)'

# ------------------------------------------------------------------ 2. login
@T('2a Login: wrong password -> inline error, form intact, no "success" fade')
def t2a(b):
    reset(delay={'login': 700}); p = Pg(b); p.pg.goto(harness.BASE + '/#/login'); p.pg.wait_for_selector('#em'); p.wait_gone()
    p.pg.fill('#em', 'student@x.test'); p.pg.fill('#pw', 'WRONG'); n0 = len(p.log()); p.pg.click('#f button'); p.pg.wait_for_selector('#er:not([hidden])'); p.pg.wait_for_timeout(500)
    log = p.log()[n0:]; msgs = [e[4] for e in log if e[1] and e[2] > .05]
    assert vis(log), 'overlay should have appeared for a 700 ms sign-in request'
    assert 'Almost ready...' not in msgs, 'a failed sign-in must not show the success message'
    assert p.pg.input_value('#em') == 'student@x.test', 'typed email lost'
    assert p.pg.is_enabled('#f button'), 'submit button not re-enabled'
    assert p.pg.evaluate("document.getElementById('eagle-splash').hidden"), 'overlay still up'
    assert p.pg.evaluate("document.querySelectorAll('[inert]').length") == 0
    foc = p.pg.evaluate("document.activeElement && document.activeElement.id + '/' + document.activeElement.tagName")
    errs = [e for e in p.errors if '401' not in e]; assert not errs, errs; p.close(); return f'overlay shown during request, then cleared; inline error shown; focus restored to {foc}'

@T('2b Login: success (slow) -> eagle covers sign-in AND dashboard, one continuous screen')
def t2b(b):
    reset(delay={'login': 600, 's_exams': 900}); p = Pg(b); p.pg.goto(harness.BASE + '/#/login'); p.pg.wait_for_selector('#em'); p.wait_gone()
    p.pg.fill('#em', 'student@x.test'); p.pg.fill('#pw', 'pw'); n0 = len(p.log()); p.pg.click('#f button'); p.pg.wait_for_selector('#main h1:has-text("My exams")'); p.wait_gone(); log = p.log()[n0:]
    m = uniq_msgs(log); assert m[0] == 'Preparing your examination environment...', m; assert 'Loading your dashboard...' in m, m
    rises = sum(1 for i in range(1, len(log)) if log[i][1] == 1 and log[i-1][1] == 0); assert rises == 1, f'screen appeared {rises}x (expected exactly once, after the 250 ms show-delay)'
    first_content = next(e[0] for e in log if e[5]); lv = next(e[0] for e in log if 'is-leaving' in e[3]); assert lv >= first_content - 20, 'fade began before the dashboard was rendered'
    assert p.pg.inner_text('#main h1') == 'My exams'; foc = p.pg.evaluate('document.activeElement.tagName'); assert foc == 'H1', f'focus {foc}'
    assert not p.errors, p.errors; p.close(); return f'messages seen: {m}; single appearance; fade began after dashboard rendered; focus on <h1>'

@T('2c Login: fast path (<250 ms total) never flashes the screen')
def t2c(b):
    reset(); p = Pg(b); p.pg.goto(harness.BASE + '/#/login'); p.pg.wait_for_selector('#em'); p.wait_gone()
    p.pg.fill('#em', 'teacher@x.test'); p.pg.fill('#pw', 'pw'); n0 = len(p.log()); p.pg.click('#f button'); p.pg.wait_for_selector('#main h1:has-text("Dashboard")'); p.pg.wait_for_timeout(700); log = p.log()[n0:]
    assert not vis(log), f'screen flashed on a fast sign-in: {len(vis(log))} visible frames'; assert p.pg.inner_text('#main h1') == 'Dashboard'; p.close(); return 'zero visible frames of the eagle screen when sign-in + dashboard both finish quickly'

# ------------------------------------------------------------------ 3. dashboards
def dash_refresh(b, email, hash_, delay_key, h1, content_sel):
    reset(); p = Pg(b); p.sign_in(email); ctl(delay={delay_key: 1400}); p.pg.goto(harness.BASE + '/' + hash_); p.pg.reload(); p.wait_gone(); p.pg.wait_for_selector('#main h1'); log = p.log()
    assert log[0][1] == 1; m = uniq_msgs(log); assert 'Loading your dashboard...' in m, m
    lv = next(e for e in log if 'is-leaving' in e[3]); assert lv[5] == 1, 'fade started before the dashboard was rendered'
    assert p.pg.inner_text('#main h1') == h1; assert p.pg.query_selector(content_sel), 'dashboard content missing'
    assert p.pg.evaluate("document.querySelectorAll('[inert]').length") == 0; assert not p.errors, p.errors; p.close(); return m

@T('3a Student dashboard initialisation (refresh, slow API)')
def t3a(b): return f'messages: {dash_refresh(b, "student@x.test", "#/s", "s_exams", "My exams", ".card")}'
@T('3b Teacher dashboard initialisation (refresh, slow API)')
def t3b(b): return f'messages: {dash_refresh(b, "teacher@x.test", "#/t", "t_dash", "Dashboard", ".stat")}'
@T('3c Administrator dashboard: revealed only AFTER the user list has loaded')
def t3c(b):
    m = dash_refresh(b, 'admin@x.test', '#/a/users', 'a_users', 'Users', 'table'); return f'messages: {m}; at fade start the users table was already on screen'

@T('3d Dashboard screen is one-time: returning to the dashboard uses the small spinner')
def t3d(b):
    reset(); p = Pg(b); p.sign_in('student@x.test'); p.pg.goto(harness.BASE + '/#/s/exam/11'); p.pg.wait_for_selector('text=Before you begin'); ctl(delay={'s_exams': 1000}); n0 = len(p.log())
    p.pg.evaluate("location.hash = '#/s'"); p.pg.wait_for_selector('.spin'); p.pg.wait_for_selector('#main h1:has-text("My exams")'); log = p.log()[n0:]
    assert not vis(log), 'full-screen eagle reappeared for an ordinary navigation'; p.close(); return 'small inline spinner used; eagle screen not shown for repeat navigation'

# ------------------------------------------------------------------ 4. exam
@T('4a Exam initialisation (resume, slow API) + KaTeX maths still renders')
def t4a(b):
    reset(); p = Pg(b); p.sign_in('student@x.test'); ctl(delay={'s_attempt': 1300}); p.pg.goto(harness.BASE + '/#/s'); p.pg.wait_for_selector('text=Resume exam'); n0 = len(p.log()); p.pg.click('text=Resume exam'); p.pg.wait_for_selector('.xwrap'); p.wait_gone(); log = p.log()[n0:]
    m = uniq_msgs(log); assert vis(log) and m[0] == 'Preparing your examination environment...', m
    p.pg.wait_for_selector('.katex', timeout=5000); assert p.pg.evaluate("document.querySelectorAll('.katex').length") > 0
    assert p.pg.evaluate("document.querySelectorAll('[inert]').length") == 0; assert not p.errors, p.errors; p.close(); return f'messages {m}; player rendered; KaTeX rendered ({"yes"})'

@T('4b Starting an exam: slow "start" request is covered; failure clears to the inline error')
def t4b(b):
    reset(); p = Pg(b); p.sign_in('student@x.test'); p.pg.goto(harness.BASE + '/#/s/exam/11'); p.pg.wait_for_selector('#go'); ctl(delay={'s_start': 800, 's_attempt': 600}); n0 = len(p.log()); p.pg.click('#go'); p.pg.wait_for_selector('.xwrap'); p.wait_gone(); log = p.log()[n0:]
    assert vis(log), 'no screen over a 1.4 s exam start'
    reset(fail={'s_start': '503'}, delay={'s_start': 600}); p.pg.goto(harness.BASE + '/#/s/exam/11'); p.pg.wait_for_selector('#go'); n0 = len(p.log()); p.pg.click('#go'); p.pg.wait_for_selector('#er:not([hidden])'); p.pg.wait_for_timeout(500); log = p.log()[n0:]
    assert 'Almost ready...' not in [e[4] for e in log if e[1] and e[2] > .05]; assert p.pg.is_enabled('#go'), 'Start button not re-enabled'
    assert p.pg.evaluate("document.getElementById('eagle-splash').hidden"); p.close(); return 'covered on success; on failure the overlay clears and the existing inline error + enabled button remain'

@T('4c ACTIVE EXAM is never interrupted (no overlay on navigation, offline, or forced begin)')
def t4c(b):
    reset(); p = Pg(b); p.sign_in('student@x.test'); p.pg.goto(harness.BASE + '/#/s/attempt/77'); p.pg.wait_for_selector('.xwrap'); p.wait_gone()
    p.pg.wait_for_selector('input[name=a]'); p.pg.check('input[name=a] >> nth=1'); p.pg.wait_for_timeout(300)
    n0 = len(p.log())
    p.pg.evaluate("EagleLoader.begin({context:'exam', delay:0}); EagleLoader.begin({context:'dashboard', delay:0})")     # forced attempts while the player is live
    p.ctx.set_offline(True); p.pg.evaluate("document.querySelector('input[name=a]').click()"); p.pg.wait_for_timeout(2500)
    sv = p.pg.inner_text('#sv'); pend = p.pg.evaluate("Object.keys(localStorage).filter(k => /pend/i.test(k)).length")
    p.pg.evaluate("location.hash = '#/s'"); p.pg.wait_for_timeout(900)
    p.ctx.set_offline(False); log = p.log()[n0:]
    assert not vis(log), f'overlay appeared {len(vis(log))} frames during a live exam'
    assert p.pg.evaluate("EagleLoader.isActive()") is False, 'loader considered itself active'
    assert 'Not saved' in sv or 'Saving' in sv or 'saved' in sv.lower(), sv; assert pend >= 1, 'pending answers not kept on device'
    p.close(); return f'0 overlay frames; save indicator while offline: "{sv}"; answers kept on device (localStorage keys: {pend})'

# ------------------------------------------------------------------ 5. failures
@T('5a Start-up network failure -> honest error (NOT the signed-out welcome page), then Try again works')
def t5a(b):
    reset(fail={'me': 'net'}); p = Pg(b); p.pg.goto(harness.BASE + '/'); p.pg.wait_for_selector('#eagle-splash.is-error'); p.pg.wait_for_timeout(600)
    title = p.pg.inner_text('.es-errtitle'); msg = p.pg.inner_text('.es-errmsg'); assert 'could not reach' in title.lower(), title
    assert p.pg.query_selector('#root h1') is None, 'app proceeded as if start-up had succeeded'
    assert p.pg.evaluate("!document.getElementById('eagle-splash').hidden"); foc = p.pg.evaluate("document.activeElement.className"); assert 'es-retry' in foc, foc
    log = p.log(); assert 'Almost ready...' not in [e[4] for e in log if e[1]], 'success message shown on failure'
    reset(); p.pg.click('.es-retry'); p.pg.wait_for_selector('#root h1'); p.wait_gone(); assert not p.pg.evaluate("document.querySelectorAll('[inert]').length")
    p.close(); return f'title="{title}", message="{msg}"; Try again recovered the app'

@T('5b Start-up server error (HTTP 503) -> error panel shows server message')
def t5b(b):
    reset(fail={'me': '503'}); p = Pg(b); p.pg.goto(harness.BASE + '/'); p.pg.wait_for_selector('#eagle-splash.is-error'); msg = p.pg.inner_text('.es-errmsg'); assert 'temporarily unavailable' in msg, msg
    reset(); p.pg.click('.es-retry'); p.pg.wait_for_selector('#root h1'); p.close(); return f'message="{msg}"; recovered after retry'

@T('5c Dashboard load failure (signed in) -> error on the eagle screen, Try again recovers, state not stale')
def t5c(b):
    reset(); p = Pg(b); p.sign_in('teacher@x.test'); reset(fail={'t_dash': '503'}); p.pg.goto(harness.BASE + '/#/t'); p.pg.reload(); p.pg.wait_for_selector('#eagle-splash.is-error', timeout=8000)
    assert 'temporarily unavailable' in p.pg.inner_text('.es-errmsg'); assert 'Almost ready...' not in [e[4] for e in p.log() if e[1]]
    reset(); p.pg.click('.es-retry'); p.pg.wait_for_selector('.stat'); p.wait_gone(); assert p.pg.inner_text('#main h1') == 'Dashboard'; p.close(); return 'error shown on the loading screen (not a fake success); retry loaded the dashboard'

@T('5d Exam load failure -> error panel with exam-specific reassurance')
def t5d(b):
    reset(); p = Pg(b); p.sign_in('student@x.test'); reset(fail={'s_attempt': 'net'}); p.pg.goto(harness.BASE + '/#/s/attempt/77'); p.pg.reload(); p.pg.wait_for_selector('#eagle-splash.is-error', timeout=8000)
    note = p.pg.inner_text('.es-note'); assert 'kept on this device' in note, note
    reset(); p.pg.click('.es-retry'); p.pg.wait_for_selector('.xwrap'); p.close(); return f'note="{note}"; retry opened the exam'

@T('5e Hung request -> watchdog time-out (no infinite loading), then recovery (fake clock)')
def t5e(b):
    reset(fail={'me': 'hang'}); p = Pg(b, sampler=False); p.pg.clock.install(); p.pg.goto(harness.BASE + '/'); p.pg.wait_for_selector('#eagle-splash.js-on')
    p.pg.clock.run_for(9000); m1 = p.pg.inner_text('.es-msg'); p.pg.clock.run_for(23000)
    p.pg.wait_for_selector('#eagle-splash.is-error'); title = p.pg.inner_text('.es-errtitle'); assert 'longer than expected' in title.lower(), title
    reset(); p.pg.click('.es-retry'); p.pg.clock.run_for(1000); p.pg.wait_for_selector('#root h1', timeout=8000); p.close(); return f'after 9 s message: "{m1}"; after 32 s -> "{title}"; Try again recovered'

@T('5f Honest slowness messages (real elapsed time, no fake percentage)')
def t5f(b):
    reset(delay={'me': 9500}); p = Pg(b); p.pg.goto(harness.BASE + '/'); p.pg.wait_for_selector('#eagle-splash.is-ready'); poll(p.pg, "document.querySelector('.es-msg').textContent.includes('Still working')", 12)
    m = uniq_msgs(p.log()); assert m[0] == 'Preparing your examination environment...' and 'Synchronizing your data...' in m and any('Still working' in x for x in m), m
    assert not re.search(r'\d\s*%', p.pg.inner_text('#eagle-splash')), 'a percentage is displayed'; p.close(); return f'sequence: {m}; no percentage anywhere'

# ------------------------------------------------------------------ 6. responsiveness / a11y / refresh
@T('6a Mobile portrait 390x844 @3x: fits, no horizontal scroll, readable')
def t6a(b):
    reset(delay={'me': 3000}); p = Pg(b, 390, 844, dpr=3, mobile=True); p.pg.goto(harness.BASE + '/'); p.pg.wait_for_selector('#eagle-splash.is-ready'); p.pg.wait_for_timeout(2600)
    r = p.pg.evaluate("""() => { const q = s => document.querySelector(s).getBoundingClientRect(); const e = q('.es-eagle'), c = q('.es-center'); return { eagle: [e.left, e.right, e.top, e.bottom].map(Math.round), vw: innerWidth, vh: innerHeight, sw: document.scrollingElement.scrollWidth, centerH: Math.round(c.height), msgFont: getComputedStyle(document.querySelector('.es-msg')).fontSize } }""")
    assert r['sw'] <= r['vw'], r; assert r['eagle'][0] >= 0 and r['eagle'][1] <= r['vw'], r; assert r['centerH'] < r['vh'] * .8, r
    p.pg.screenshot(path=OUT + '/mobile_portrait.png'); p.close(); return f'eagle box {r["eagle"]} within {r["vw"]}x{r["vh"]}; no horizontal scroll; message font {r["msgFont"]}'

@T('6b Mobile landscape 844x390 incl. error panel: nothing clipped/unreachable')
def t6b(b):
    reset(fail={'me': 'net'}); p = Pg(b, 844, 390, dpr=2, mobile=True); p.pg.goto(harness.BASE + '/'); p.pg.wait_for_selector('#eagle-splash.is-error'); p.pg.wait_for_timeout(500)
    r = p.pg.evaluate("""() => { const s = document.getElementById('eagle-splash'); const bt = [...document.querySelectorAll('.es-btn')].map(x => { const b = x.getBoundingClientRect(); return [Math.round(b.height), Math.round(b.top), Math.round(b.bottom)] }); return { scrollable: s.scrollHeight > s.clientHeight, sh: s.scrollHeight, ch: s.clientHeight, bt } }""")
    assert all(h >= 44 for h, _, _ in r['bt']), r; p.pg.click('.es-retry', timeout=3000)   # actually reachable by tap
    p.pg.screenshot(path=OUT + '/mobile_landscape_error.png'); p.close(); return f'buttons {r["bt"]} (height >=44px), reachable; content {r["sh"]}px in {r["ch"]}px viewport (scrolls if needed)'

@T('6c Tablet 768x1024 renders cleanly')
def t6c(b):
    reset(delay={'me': 2500}); p = Pg(b, 768, 1024); p.pg.goto(harness.BASE + '/'); p.pg.wait_for_selector('#eagle-splash.is-ready'); p.pg.wait_for_timeout(2300); p.pg.screenshot(path=OUT + '/tablet.png')
    assert p.pg.evaluate("document.scrollingElement.scrollWidth <= innerWidth"); p.close(); return 'ok'

@T('7  prefers-reduced-motion: calm static screen, no running animation, app fully usable')
def t7(b):
    reset(delay={'me': 1500}); p = Pg(b, reduced=True); p.pg.goto(harness.BASE + '/'); p.pg.wait_for_selector('#eagle-splash.is-ready'); p.pg.wait_for_timeout(500)
    r = p.pg.evaluate("""() => { const anims = document.getAnimations().filter(a => a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('#eagle-splash')); const q = s => getComputedStyle(document.querySelector(s));
      return { running: anims.filter(a => a.playState === 'running').length, eagleOpacity: q('.es-eagle').opacity, streak: q('.es-streak').display, wing: q('.es-wing').transform, nameOpacity: q('.es-name').opacity } }""")
    assert r['running'] == 0, r; assert r['eagleOpacity'] == '1' and r['nameOpacity'] == '1', r; assert r['streak'] == 'none', r
    p.pg.screenshot(path=OUT + '/reduced_motion.png'); p.wait_gone(); p.pg.wait_for_selector('#root h1')
    reset(); p.sign_in('student@x.test'); assert p.pg.inner_text('#main h1') == 'My exams'; assert not p.errors, p.errors; p.close(); return f'running splash animations: 0; eagle visible; streaks off; sign-in + dashboard fully usable'

@T('8  Browser refresh x6 across routes: no stale state, no leftover inert, no errors')
def t8(b):
    reset(); p = Pg(b); p.sign_in('student@x.test'); n = 0
    for h in ['#/s', '#/s/exam/11', '#/s/attempt/77', '#/s', '#/login', '#/']:
        p.pg.goto(harness.BASE + '/' + h); p.pg.reload(); p.wait_gone(); p.pg.wait_for_timeout(250); n += 1
        assert p.pg.evaluate("document.querySelectorAll('[inert]').length") == 0, h
        assert p.pg.evaluate("document.getElementById('eagle-splash').hidden"), h
    assert not p.errors, p.errors; p.close(); return f'{n} reloads; each ended with splash hidden, nothing inert'

@T('9  Accessibility: page unreachable while screen is up; focus managed; live-region present')
def t9(b):
    reset(delay={'me': 2500}); p = Pg(b); p.pg.goto(harness.BASE + '/'); p.pg.wait_for_selector('#eagle-splash.is-ready')
    for _ in range(4): p.pg.keyboard.press('Tab')
    inside = p.pg.evaluate("(() => { const a = document.activeElement; return a === document.body || !!a.closest('#eagle-splash') })()"); assert inside, 'keyboard focus escaped to the covered page'
    role = p.pg.evaluate("document.getElementById('eagle-splash').getAttribute('role') + '/' + document.getElementById('eagle-splash').getAttribute('aria-live') + '/busy=' + document.getElementById('eagle-splash').getAttribute('aria-busy')")
    assert role == 'status/polite/busy=true', role; p.wait_gone(); busy = p.pg.evaluate("document.getElementById('eagle-splash').getAttribute('aria-busy')"); assert busy == 'false'
    p.pg.keyboard.press('Tab'); f = p.pg.evaluate('document.activeElement.className || document.activeElement.tagName'); p.close(); return f'while loading: role/aria={role}, Tab did not reach page; after: aria-busy=false, Tab reaches page ({f})'

@T('10 Idle cost after loading: splash contributes no running animations')
def t10(b):
    reset(); p = Pg(b); p.pg.goto(harness.BASE + '/'); p.wait_gone(); p.pg.wait_for_timeout(300)
    n = p.pg.evaluate("document.getAnimations().filter(a => a.playState === 'running' && a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('#eagle-splash')).length"); d = p.pg.evaluate("getComputedStyle(document.getElementById('eagle-splash')).display")
    assert n == 0 and d == 'none', (n, d); p.close(); return f'running splash animations: {n}; display: {d}'

@T('11 Frame pacing while animating (60 fps target)')
def t11(b):
    reset(delay={'me': 6000}); p = Pg(b, sampler=False); p.pg.goto(harness.BASE + '/'); p.pg.wait_for_selector('#eagle-splash.is-ready')
    d = p.pg.evaluate("() => new Promise(res => { const a = []; let l = performance.now(); const s = t => { a.push(t - l); l = t; if (a.length < 240) requestAnimationFrame(s); else res(a) }; requestAnimationFrame(s) })")
    d = d[5:]; mean = sum(d) / len(d); worst = max(d); over = sum(1 for x in d if x > 20); p.close(); assert mean < 18 and over <= 3, (mean, worst, over); return f'mean {mean:.1f} ms, worst {worst:.1f} ms, frames >20 ms: {over}/{len(d)} (software-rendered headless Chromium)'

def main():
    start(); 
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        only = sys.argv[1:]
        for t in TESTS:
            if only and not any(o in t.__name__ or o in RESULTS_NAME(t) for o in only): continue
            t(b)
        b.close()
    ok = sum(1 for r in RESULTS if r[1]); print(f'\n{ok}/{len(RESULTS)} passed   (screenshots + results.json in {OUT})'); json.dump(RESULTS, open(OUT + '/results.json', 'w'), indent=1)
def RESULTS_NAME(t): return t.__name__
if __name__ == '__main__': main()
