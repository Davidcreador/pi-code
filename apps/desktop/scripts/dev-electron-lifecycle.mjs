export function recordSpawnedDevApp(updateRecord, killApp) {
  try {
    if (updateRecord()) return;
    throw new Error("Lost ownership of the dev Electron PID record while starting the app.");
  } catch (error) {
    killApp();
    throw error;
  }
}

export async function settlePendingRestartBeforeShutdown(restartQueue, stopApp) {
  await restartQueue.catch(() => undefined);
  await stopApp();
}
