// Owner-operated local utility. No credentials or generation worker are loaded.
import { openStudio, restoreStudioBackup } from "../src/engine/index.js";
import { createStudioBackup } from "../src/engine/backup.js";
const [action, location, subject] = process.argv.slice(2);
let service;
try {
  if (
    !location ||
    !subject ||
    !["backup", "restore", "support"].includes(action)
  )
    throw Error("usage");
  if (action === "restore") {
    service = await restoreStudioBackup({
      archive: location,
      directory: subject,
    });
    process.stdout.write(
      JSON.stringify({
        restored: true,
        execution: "held_at_restore_boundary",
      }) + "\n",
    );
  } else {
    service = await openStudio({ directory: location, providers: {} });
    const result =
      action === "backup"
        ? await createStudioBackup(service, subject)
        : await service.supportBundle(subject);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
} catch (error) {
  process.stderr.write(
    `Studio backup utility failed: ${error.code ?? "INVALID_ARGUMENTS"}. Usage: node scripts/backup.js backup|support PROJECT_DIRECTORY PROJECT_ID; restore ARCHIVE_DIRECTORY NEW_DIRECTORY\n`,
  );
  process.exitCode = 1;
} finally {
  await service?.close();
}
