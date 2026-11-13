import json
R=[]
def rec(n,ok,d=''): R.append((n,bool(ok),d)); print(('PASS' if ok else 'FAIL'),n,d,flush=True)
async def newpage(b,vw=1280,vh=800,**kw):
    ctx=await b.new_context(viewport={'width':vw,'height':vh},**kw); pg=await ctx.new_page()
    errs=[]; pg.on('console',lambda m: errs.append(m.text) if m.type in('error','warning') else None); pg.on('pageerror',lambda e: errs.append(str(e))); pg.errs=errs; return pg
async def login(pg,who):
    await pg.goto('http://localhost:4010/#/login'); await pg.wait_for_selector('#em'); await waitjs(pg,'!EagleLoader.isOn()')
    await pg.fill('#em',who+'@x'); await pg.fill('#pw','pw'); await pg.click('#f button[type=submit]')
async def waitjs(pg,expr,timeout=8000,step=60):
    import asyncio, time
    t=time.time()
    while (time.time()-t)*1000<timeout:
        if await pg.evaluate(expr): return True
        await asyncio.sleep(step/1000)
    raise TimeoutError('waitjs: '+expr)
