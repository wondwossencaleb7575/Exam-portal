# Browser tests for the flying-eagle loader (optional)

Real Chromium, driven by Playwright, against **your real `public/` files served with your exact CSP header** and a small fake API
(`mock-server.js`) whose latency and failures the tests control. It does not need PostgreSQL and never touches real data.

    pip install playwright && playwright install chromium
    python3 tests/browser-loader/t1.py   # start-up, fast-load no-flash, layout shift, student/teacher/admin dashboards, exam flow, refresh
    python3 tests/browser-loader/t2.py   # server down, dropped connection, 500s, failed exam start, retry, slow network, 40 s hard time-out (about 90 s)
    python3 tests/browser-loader/t3.py   # mobile sizes, reduced motion, accessibility, CPU, payload, Firefox/WebKit when installed

Run from any folder; screenshots and `results_*.json` are written to `./shots` and the current folder.
The fast, database-free checks run with the normal `npm test` (`tests/loader.test.js`).
