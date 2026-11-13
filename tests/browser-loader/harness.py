import subprocess, os, time, json, urllib.request, socket, contextlib
HERE = os.path.dirname(os.path.abspath(__file__))
ROOTDIR = os.environ.get('PORTAL_ROOT') or os.path.abspath(os.path.join(HERE, '..', '..'))   # the project root
URL = 'http://localhost:4010'
@contextlib.contextmanager
def mock():
    """Serves the project's REAL public/ files with the project's exact CSP, plus a fake API with injectable delay/failure."""
    env = dict(os.environ, ROOT=ROOTDIR, PORT='4010')
    p = subprocess.Popen(['node', os.path.join(HERE, 'mock-server.js')], cwd=ROOTDIR, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    for _ in range(50):
        try: socket.create_connection(('localhost', 4010), timeout=.2).close(); break
        except OSError: time.sleep(.1)
    try: yield
    finally: p.terminate(); p.wait(timeout=5)
def cfg(delay=None, fail=None):
    r = urllib.request.Request(URL + '/__cfg', data=json.dumps({'delay': delay or {}, 'fail': fail or {}}).encode(), headers={'Content-Type': 'application/json'}); urllib.request.urlopen(r, timeout=3).read()
def hits():
    return json.loads(urllib.request.urlopen(URL + '/__hits', timeout=3).read())
