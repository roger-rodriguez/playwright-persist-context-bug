# Headless Chromium Persistent Context Fails Cookie Read & Corrupts Profile on macOS

This is a simple example of a bug in Playwright when using `chromium.launchPersistentContext` with a persistent context that has a cookie set.

## Environment

* Playwright Version: 1.51.1
* Operating System: macOS Sequoia 15.3.2 (Apple M1 Pro)
* Node.js version: 22.14.0
* Browser: Chromium (using `playwright.chromium`)

## Problem Description

When using `chromium.launchPersistentContext` on macOS with a specific `userDataDir`, the headless browser instance fails to read cookies set in a previous headful session using the same `userDataDir`. Furthermore, the headless instance fails to shut down cleanly, leaving profile lock files (`SingletonLock`) and potentially corrupting profile databases, preventing subsequent launches (headful or headless) using that same `userDataDir` until the lock file is manually removed. Even after removing the lock file, subsequent launches may show profile corruption errors/pop-ups.

This demonstrates a fundamental issue with state persistence and clean shutdown for headless persistent contexts on macOS.

## Steps to Reproduce

1. Run `npm install` to install the dependencies.
2. Run `npm run dev` to start the server and run the test.
3. During Step 1 (headful), just close the opened browser window manually when it is opened and loaded.
4. Observe the logs for Step 2 (headless) and Step 3 (headful).

## Expected Behavior

* Step 2 (headless) should log `>>> SUCCESS: Found cookie 'myTestCookie' with value 'setInHeadful' <<<`.
* Step 3 (headful) should launch without errors and also log `>>> SUCCESS: Found cookie 'myTestCookie' with value 'setInHeadful' <<<`.

## Actual Behavior

* Step 2 (headless) logs `!!! FAILURE: Did not find cookie 'myTestCookie' !!!`. Internal logs show database lock errors (e.g., `shared_proto_db/metadata/LOCK`). Playwright reports the process exited cleanly (`exitCode=0, signal=null`).
* Step 3 (headful) fails to launch correctly due to profile issues caused by the unclean headless shutdown.
  * *With* the `SingletonLock` removal workaround, it launches but shows the Chromium profile error pop-up "Something went wrong when opening your profile. Some features may be unavailable." and logs various database errors (`ukm_database_backend`, `login_database`, etc.). It will also log `!!! FAILURE: Did not find cookie 'myTestCookie' !!!` because the profile state was damaged/not read correctly.
  * *Without* the `SingletonLock` removal workaround, it fails immediately with the `SingletonLock: File exists (17)` error.

## Log Snippets (Anonymized)

*From Step 2 (Headless Run):*

```shell
pw:browser [pid=[pid]][err] [0402/172441.728052:WARNING:leveldb_database.cc(137)] Unable to open Default/shared_proto_db/metadata: IO error: .../shared_proto_db/metadata/LOCK: No further details. (ChromeMethodBFE: 15::LockFile::1)
... (Many graphics/display errors) ...
!!! FAILURE: Did not find cookie 'myTestCookie' !!!
Closing context cleanly...
pw:browser [pid=[pid]] <gracefully close start>
pw:browser [pid=[pid]] <process did exit: exitCode=0, signal=null>  <-- Reports clean exit
pw:browser [pid=[pid]] starting temporary directories cleanup
pw:browser [pid=[pid]] finished temporary directories cleanup
pw:browser [pid=[pid]] <gracefully close end>
Context closed.
```

*From Step 3 (Headful Run - with SingletonLock removal workaround active):*

```shell
[Workaround] Attempting to remove lock file (if it exists): .../SingletonLock
[Workaround] Finished removal attempt.
pw:browser <launching> /path/to/chromium ... --user-data-dir=... ...
pw:browser <launched> pid=[pid]
pw:browser [pid=[pid]][err] [... ERROR:ukm_database_backend.cc(147)] Failed to open UKM database: 0 database is locked
pw:browser [pid=[pid]][err] [... ERROR:login_database.cc(1128)] Unable to open the password store database.
pw:browser [pid=[pid]][err] [... ERROR:login_database_async_helper.cc(87)] Could not create/open login database.
pw:browser [pid=[pid]][err] [... ERROR:top_sites_backend.cc(78)] Failed to initialize database.
... (Browser window shows profile error pop-up) ...
```

## Additional Notes

* The issue persists with the latest Playwright version.
* Attempting to use `channel: 'chrome'` instead of the bundled Chromium did not resolve the issue.
* The problem seems tied to the headless browser process not correctly releasing locks or finalizing writes to the profile databases upon closing, despite signaling a successful exit.
* The Playwright documentation for `userDataDir` specifically states that it "stores browser session data like cookies and local storage" but gives no warnings about different behavior between headless and headful modes.
