type ShutdownDependencies = {
  stop: () => Promise<void>;
  closeHttp: () => Promise<void>;
  closeStore: () => void;
};

/** False means the caller must terminate the process, not close its active store. */
export async function shutdownService(deps: ShutdownDependencies): Promise<boolean> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>(resolve => {
    timer = setTimeout(() => { expired = true; resolve(false); }, 10000);
  });
  try {
    const httpClosed = Promise.resolve().then(() => deps.closeHttp());
    const stopped = Promise.resolve().then(() => deps.stop()).then(() => {
      if (!expired) deps.closeStore();
    });
    const drained = Promise.all([httpClosed, stopped]).then(() => true);
    return await Promise.race([drained, timeout]);
  } finally {
    // Also guard a late stop completion after a timeout or another shutdown error.
    expired = true;
    clearTimeout(timer);
  }
}
