import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
import { Browser, BrowserContext, chromium } from "playwright";
import { exec } from "child_process";
import { promisify } from "util";

import { startServer, stopServer } from "./server.js";
import type { ServerControl } from "./server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Promisify exec for easier async/await usage
const execAsync = promisify(exec);

// --- Configuration ---
const SERVER_PORT = 8080;
const userDataDir = path.join(__dirname, "browser-data", "persistent-profile");
const htmlFilePath = path.join(__dirname, "test.html");
const htmlFileUrl = `http://localhost:${SERVER_PORT}/`;
const testCookie = {
  name: "myTestCookie",
  value: "setInHeadful",
  domain: "localhost",
  path: "/",
};
// --- End Configuration ---

async function runTestStep(
  headlessMode: boolean,
  step: number,
  setCookie: boolean
): Promise<boolean> {
  console.log(`\n--- Running Step ${step} (Headless: ${headlessMode}) ---`);
  console.log(`Using userDataDir: ${userDataDir}`);

  let browserContext: BrowserContext | null = null;
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
        success = false;
      }
    }

    // For headful step 1, wait for manual close, then attempt graceful close
    if (setCookie && !headlessMode) {
      console.log(
        ">>> Cookie Set. Please close the browser window manually to continue. <<<"
      );
      await new Promise<void>((resolve) =>
        (page as any).once("close", resolve)
      );
      console.log("Browser window closed by user.");

      if (browserContext && browserContext.close) {
        console.log(
          "Attempting graceful context close (might not terminate process)..."
        );
        try {
          await browserContext.close();
        } catch (e: any) {
          console.warn(`Graceful context close failed: ${e.message}`);
        }
        browserContext = null;
      }
    } else {
      // For Steps 2 & 3, close context normally.
      console.log("Closing context cleanly for this step...");
      await browserContext.close();
      console.log("Context closed.");
      browserContext = null;
    }
  } catch (error: any) {
    if (
      error.message?.includes("Target closed") ||
      error.message?.includes("browser has been closed") ||
      error.message?.includes("BrowserContext has been closed")
    ) {
      console.warn(
        `Ignoring error during step execution, likely due to intended closure: ${error.message}`
      );
    } else {
      console.error(
        `Error during test (Step ${step}, Headless: ${headlessMode}):`,
        error
      );
      success = false;
    }
  } finally {
    if (browserContext && browserContext.close) {
      try {
        await browserContext.close();
      } catch {
        /* Ignore */
      }
    }
  }
  return success;
}

(async () => {
  let serverControl: ServerControl | null = null;
  process.exitCode = 0;
  let foundPid: number | null = null; // Variable to store PID found via CLI

  try {
    await fs.ensureDir(path.dirname(userDataDir));
    console.log("Ensuring clean profile directory before Step 1...");
    await fs.remove(userDataDir);
    await fs.ensureDir(userDataDir);

    serverControl = await startServer(htmlFilePath, SERVER_PORT);

    console.log("Executing Step 1: Initial headful run to set cookie...");
    await runTestStep(false, 1, true);

    // --- Find PID using CLI command ---
    console.log(`\nAttempting to find PID for userDataDir: ${userDataDir}...`);
    let findPidCommand = "";
    if (process.platform === "win32") {
      // Escape backslashes for wmic query
      const escapedUserDataDir = userDataDir.replace(/\\/g, "\\\\");
      findPidCommand = `wmic process where "commandline like '%--user-data-dir=${escapedUserDataDir}%'" get processid /value`;
    } else {
      // Use pgrep -f for macOS/Linux
      // Ensure the path is quoted properly in case it contains spaces or special characters
      findPidCommand = `pgrep -f -- "--user-data-dir=${userDataDir}"`;
    }

    try {
      console.log(`Executing find PID command: ${findPidCommand}`);
      const { stdout } = await execAsync(findPidCommand);
      const output = stdout.trim();
      console.log(`Find PID command output: ${output || "(no output)"}`);

      if (output) {
        if (process.platform === "win32") {
          // Parse wmic output like "ProcessId=1234"
          const match = output.match(/ProcessId=(\d+)/);
          if (match && match[1]) {
            foundPid = parseInt(match[1], 10);
          }
        } else {
          // pgrep output is usually just the PID(s), take the first one
          const pids = output
            .split("\n")
            .map((pid) => parseInt(pid.trim(), 10))
            .filter((pid) => !isNaN(pid));
          if (pids.length > 0) {
            foundPid = pids[0]; // Take the first PID if multiple are found (unlikely for unique path)
            if (pids.length > 1) {
              console.warn(
                `Found multiple PIDs (${pids.join(
                  ", "
                )}) matching the userDataDir, using the first: ${foundPid}`
              );
            }
          }
        }
      }

      if (foundPid) {
        console.log(`Found lingering process PID via CLI: ${foundPid}`);
      } else {
        console.log(
          "Could not find lingering process PID via CLI (process might have exited or command failed)."
        );
      }
    } catch (findPidError: any) {
      // pgrep/wmic might error if no process is found, treat this as non-fatal
      // Check standard error as well for messages like "No such process"
      const errorOutput =
        findPidError.stderr?.toLowerCase() ||
        findPidError.message?.toLowerCase() ||
        "";
      const noProcessFound =
        errorOutput.includes("no such process") || findPidError.code === 1; // pgrep returns 1 if no match

      if (noProcessFound) {
        console.log("Command to find PID indicated no matching process.");
      } else {
        console.warn(
          `Command to find PID failed: ${findPidError.message} (Code: ${findPidError.code})`
        );
        console.warn(`Stderr: ${findPidError.stderr || "(no stderr)"}`);
      }
      foundPid = null; // Ensure PID is null if command fails or finds nothing
    }
    // --- End Find PID ---

    // --- Force Kill Step 1 Browser Process using found PID ---
    if (foundPid) {
      console.log(
        `\nAttempting to forcefully kill process with found PID: ${foundPid}...`
      );
      const killCommand =
        process.platform === "win32"
          ? `taskkill /PID ${foundPid} /F`
          : `kill -9 ${foundPid}`;

      try {
        console.log(`Executing kill command: ${killCommand}`);
        const { stdout: killStdout, stderr: killStderr } = await execAsync(
          killCommand
        );
        console.log(`Kill command stdout: ${killStdout || "(no stdout)"}`);
        console.log(`Kill command stderr: ${killStderr || "(no stderr)"}`);
        console.log(`Forced kill attempt on PID ${foundPid} finished.`);
      } catch (killError: any) {
        // Check for errors indicating the process was already gone
        const errorOutput =
          killError.stderr?.toLowerCase() ||
          killError.message?.toLowerCase() ||
          "";
        const alreadyGone =
          errorOutput.includes("no such process") || // kill -9
          (errorOutput.includes("process with pid") &&
            errorOutput.includes("not found")); // taskkill

        if (alreadyGone) {
          console.log(
            `Kill command indicated PID ${foundPid} was already gone.`
          );
        } else {
          console.warn(
            `Warning during kill command execution for PID ${foundPid}: ${killError.message} (Code: ${killError.code})`
          );
          console.warn(`Stderr: ${killError.stderr || "(no stderr)"}`);
        }
      }
    } else {
      console.warn("\nSkipping kill command: PID was not found via CLI.");
    }
    // --- End Force Kill ---

    console.log("Waiting briefly after find/kill attempt...");
    await new Promise((resolve) => setTimeout(resolve, 4000)); // delay

    if (process.exitCode !== 0 && process.exitCode !== undefined) {
      console.error(
        "Step 1 encountered critical errors unrelated to closing. Aborting."
      );
      return;
    }

    console.log(
      "\nExecuting Step 2: Testing headless read with existing profile..."
    );
    const step2Success = await runTestStep(true, 2, false);
    if (!step2Success) {
      console.error("Step 2 failed. Aborting subsequent steps.");
      process.exitCode = 1;
      return;
    }

    console.log(
      "\nExecuting Step 3: Testing headful read again + launch check..."
    );
    const step3Success = await runTestStep(false, 3, false);
    if (!step3Success) {
      console.error("Step 3 failed.");
      process.exitCode = 1;
      return;
    }

    console.log("\nAll steps completed successfully in the same Node process.");
  } catch (error) {
    console.error("Unhandled error in main execution:", error);
    process.exitCode = 1;
  } finally {
    console.log("\nTest sequence finished. Cleaning up server.");
    await stopServer(serverControl);
    console.log(`Exiting with code: ${process.exitCode}`);
  }
})();
