import json, os, subprocess, time, urllib.request, atexit
import pathlib
HERE = pathlib.Path(__file__).resolve().parent
APP = str(HERE.parent.parent)                                   # the exam-portal folder
BASE = 'http://localhost:4100'
_proc = None
def start(public=None, port=4100):
    global _proc, BASE
    BASE = f'http://localhost:{port}'
    env = dict(os.environ, APP_ROOT=APP, PORT=str(port))
    if public: env['PUBLIC_DIR'] = public
    _proc = subprocess.Popen(['node', str(HERE / 'stub-server.js')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(50):
        try: urllib.request.urlopen(BASE + '/api/auth/me').read(); break
        except Exception: time.sleep(0.1)
    atexit.register(stop)
def stop():
    global _proc
    if _proc: _proc.terminate(); _proc = None
def ctl(**kw):
    r = urllib.request.Request(BASE + '/__ctl', data=json.dumps(kw).encode(), headers={'Content-Type': 'application/json'}); return json.loads(urllib.request.urlopen(r).read())
