import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
import { chromium } from "playwright";

import { startServer, stopServer } from "./server.js";
import type { ServerControl } from "./server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const SERVER_PORT = 8080;
const userDataDir = path.join(
  __dirname,
  "browser-data",
  "profile-" + Date.now()
);
const htmlFilePath = path.join(__dirname, "test.html");
const htmlFileUrl = `http://localhost:${SERVER_PORT}/`;
const testCookie = {
  name: "myTestCookie",
  value: "setInHeadful",
  domain: "localhost",
  path: "/",
};
// --- End Configuration ---

async function runTest(
  headlessMode: boolean,
  step: number,
  setCookie: boolean
) {
  console.log(`\n--- Running Step ${step} (Headless: ${headlessMode}) ---`);
  console.log(`Using userDataDir: ${userDataDir}`);

  // --- Workaround attempt: Delete lock file before launch ---
  // const lockfilePath = path.join(userDataDir, "SingletonLock");
  // console.log(
  //   `[Workaround] Attempting to remove lock file (if it exists): ${lockfilePath}`
  // );
  // try {
  //   await fs.remove(lockfilePath); // Directly attempt removal
  //   console.log(`[Workaround] Finished removal attempt.`);
  // } catch (err) {
  //   console.warn(`[Workaround] Error during fs.remove: ${err}`);
  // }
  // --- End Workaround ---

  let browserContext = null;
  let success = true;
  try {
    browserContext = await chromium.launchPersistentContext(userDataDir, {
      headless: headlessMode,
    });

    // Set cookie in Step 1
    if (setCookie) {
      console.log(`Setting cookie: ${testCookie.name}=${testCookie.value}`);
      await browserContext.addCookies([testCookie]);
    }

    const page = await browserContext.newPage();
    console.log(`Navigating to: ${htmlFileUrl}`);
    await page.goto(htmlFileUrl, { waitUntil: "domcontentloaded" });
    console.log(`Navigation complete.`);

    // Check for cookie in Steps 2 & 3
    if (!setCookie) {
      const cookies = await browserContext.cookies(htmlFileUrl);
      const foundCookie = cookies.find((c) => c.name === testCookie.name);
      if (foundCookie) {
        console.log(
          `>>> SUCCESS: Found cookie '${foundCookie.name}' with value '${foundCookie.value}' <<<`
        );
      } else {
        console.log(
          `!!! FAILURE: Did not find cookie '${testCookie.name}' !!!`
        );
        if (headlessMode) {
          console.log("(This is expected failure in Step 2 due to the bug)");
        }
      }
    }

    // For headful step 1, wait for manual close after setting cookie
    if (setCookie && !headlessMode) {
      console.log(
        ">>> Cookie Set. Please close the browser window manually to continue. <<<"
      );
      await new Promise<void>((resolve) => (page as any).on("close", resolve));
      console.log("Browser window closed by user.");
      // Explicitly return true as context is closed by user action here
      return true;
    }

    console.log("Closing context cleanly...");
    await browserContext.close();
    console.log("Context closed.");
  } catch (error: any) {
    console.error(
      `Error during test (Step ${step}, Headless: ${headlessMode}):`,
      error
    );
    success = false; // Mark as failed
    if (browserContext) {
      console.log("Attempting force close due to error...");
      // context.close() might fail again if already in a bad state
      try {
        await browserContext.close();
      } catch {
        /* Ignore secondary close errors */
      }
    }
  }
  // Return false if we got here without explicitly returning true (e.g. Step 1 success)
  // or if an error occurred.
  return success && !setCookie;
}

(async () => {
  let serverControl: ServerControl | null = null;

  try {
    // Ensure the base directory exists
    await fs.ensureDir(path.dirname(userDataDir));

    // Start the HTTP server using the imported function
    serverControl = await startServer(htmlFilePath, SERVER_PORT);

    // Step 1: Run headful to create profile and set cookie
    console.log("Step 1: Initial headful run to set cookie...");
    const step1Success = await runTest(false, 1, true);
    if (!step1Success) {
      console.error(
        "Step 1 did not complete successfully (User may not have closed window). Aborting."
      );
      return; // Don't proceed if Step 1 didn't finish right
    }

    // Step 2: Run headless using the *same* profile, try reading cookie
    console.log("\nStep 2: Testing headless read with existing profile...");
    await runTest(true, 2, false);

    // Step 3: Run headful again to check launch and read cookie
    console.log("\nStep 3: Testing headful read again + launch check...");
    await runTest(false, 3, false);
  } finally {
    console.log("\nTest finished. Cleaning up.");
    try {
      await stopServer(serverControl);
      // await fs.remove(userDataDir);
      // console.log(`Removed profile dir: ${userDataDir}`);
      process.exit(0);
    } catch (err) {
      console.error("Error during cleanup:", err);
    }
  }
})();
