(() => {
  const loadedVersion = document.querySelector('meta[name="app-version"]')?.content;
  if (!/^[a-f0-9]{64}$/.test(loadedVersion || '')) return;
  let checking = false;
  let updating = false;
  let candidate = null;

  function reload(version) {
    updating = true;
    const notice = document.createElement('div');
    notice.className = 'update-overlay';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    const message = document.createElement('p');
    message.textContent = 'Actualizando Mi Mesa…';
    notice.appendChild(message);
    document.body.appendChild(notice);
    setTimeout(() => {
      const destination = new URL(window.location.href);
      destination.searchParams.set('actualizar', version);
      window.location.replace(destination.href);
    }, 350);
  }

  async function checkVersion() {
    if (checking || updating || document.visibilityState === 'hidden') return;
    checking = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/api/version', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) return;
      const { version } = await response.json();
      if (!/^[a-f0-9]{64}$/.test(version || '')) return;
      if (version === loadedVersion) { candidate = null; return; }
      // Confirm the new deployment before leaving the current page.
      if (candidate === version) reload(version);
      else { candidate = version; setTimeout(checkVersion, 3000); }
    } catch {
      candidate = null;
    } finally {
      clearTimeout(timeout);
      checking = false;
    }
  }

  setInterval(checkVersion, 30000);
  window.addEventListener('pageshow', checkVersion);
  window.addEventListener('online', checkVersion);
  document.addEventListener('visibilitychange', checkVersion);
  checkVersion();
})();
