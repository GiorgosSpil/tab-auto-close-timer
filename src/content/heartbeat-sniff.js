(() => {
  const MATCH = 'SessionHeartbeat.ashx';

  function report(rawUrl) {
    try {
      const abs = new URL(rawUrl, location.href).toString();
      window.postMessage({ source: 'tact-heartbeat', url: abs }, location.origin);
    } catch {}
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : input?.url;
        if (typeof url === 'string' && url.includes(MATCH)) report(url);
      } catch {}
      return origFetch.apply(this, arguments);
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (typeof url === 'string' && url.includes(MATCH)) report(url);
    } catch {}
    return origOpen.apply(this, arguments);
  };
})();
