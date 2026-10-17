// MCP Apps sandbox proxy (spec: web hosts MUST render views through a proxy on a different origin).
// Host (localhost:5180) -> proxy iframe (this origin, allow-scripts allow-same-origin) -> inner iframe
// (srcdoc, allow-scripts only, CSP from the resource metadata). The proxy relays every message except
// ui/notifications/sandbox-* and never originates requests itself.
export const SANDBOX_PROXY_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self' blob: data:">
<style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><script>
(function(){
  var inner = null, hostOrigin = null;
  function cspFor(meta){
    var c = (meta && meta.csp) || {};
    var j = function(a){ return (a && a.length) ? ' ' + a.join(' ') : ''; };
    return "default-src 'none'; script-src 'self' 'unsafe-inline'" + j(c.resourceDomains) +
      "; style-src 'self' 'unsafe-inline'" + j(c.resourceDomains) +
      "; img-src 'self' data:" + j(c.resourceDomains) + "; font-src 'self' data:" + j(c.resourceDomains) +
      "; media-src 'self' data:" + j(c.resourceDomains) +
      "; connect-src " + ((c.connectDomains && c.connectDomains.length) ? c.connectDomains.join(' ') : "'none'") +
      "; frame-src " + ((c.frameDomains && c.frameDomains.length) ? c.frameDomains.join(' ') : "'none'") +
      "; base-uri " + ((c.baseUriDomains && c.baseUriDomains.length) ? c.baseUriDomains.join(' ') : "'self'") + "; object-src 'none'";
  }
  window.addEventListener('message', function(e){
    var m = e.data; if (!m || m.jsonrpc !== '2.0') return;
    if (inner && e.source === inner.contentWindow) {           // view -> host
      if (typeof m.method === 'string' && m.method.indexOf('ui/notifications/sandbox-') === 0) return;
      parent.postMessage(m, hostOrigin || '*'); return;
    }
    if (e.source !== parent) return;
    hostOrigin = e.origin;
    if (m.method === 'ui/notifications/sandbox-resource-ready') {   // host -> proxy: load the view
      var p = m.params || {};
      var html = String(p.html || '');
      var meta = '<meta http-equiv="Content-Security-Policy" content="' + cspFor(p).replace(/"/g,'&quot;') + '">';
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, function(h){ return h + meta; }) : meta + html;
      inner = document.createElement('iframe');
      inner.setAttribute('sandbox', p.sandbox || 'allow-scripts');
      inner.setAttribute('title', 'Stoop card');
      inner.srcdoc = html;
      document.body.replaceChildren(inner);
      return;
    }
    if (inner) inner.contentWindow.postMessage(m, '*');             // host -> view
  });
  parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, '*');
})();
</script></body></html>`;
