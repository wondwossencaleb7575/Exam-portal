# Eagle loader: real-browser tests

26 end-to-end checks of the loading screen in headless Chromium, covering first load, sign-in, the three dashboards, exam
start/resume, the live-exam guarantee, network failures, hung requests, slow connections, mobile, reduced-motion, accessibility
and refresh. The app's real `public/` files are served under the **production CSP**.

**These tests use a stub API (`stub-server.js`), not the real server or a database**, so latency and failures can be injected
precisely. Response shapes follow what `student.js`, `teacher.js`, `admin.js` and `core.js` consume. They test the front end,
not the back end; `npm test` still covers the back end.

## Run
```
cd exam-portal && npm install                 # express + katex are already dependencies
pip install playwright && playwright install chromium
python3 tests/eagle-loader-browser/test_eagle_loader.py            # all checks (about 90 seconds)
python3 tests/eagle-loader-browser/test_eagle_loader.py 5e 7       # only tests whose name matches
EAGLE_TEST_OUT=./shots python3 tests/eagle-loader-browser/test_eagle_loader.py   # keep the screenshots somewhere you choose
```
Python 3.9+. Only Chromium is exercised. Firefox and Safari are not covered (see TESTING.md).
