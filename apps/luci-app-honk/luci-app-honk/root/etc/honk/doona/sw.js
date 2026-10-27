const PREFIX = `doona-shell:${self.registration.scope}:`;
// The page reads the same build from index.html, to tell whether this worker taking it over is a new build.
const BUILD = '6b919442510d8b13';
const CACHE = PREFIX + BUILD;
const PRECACHE = ["assets/AddCircle-Bl7yHPBv.js","assets/AppearanceControls-5nB_BQSG.js","assets/AreaChart-VpEWQmQw.js","assets/AreaCurve-DQSHOSpG.js","assets/CardView-Cz1YW93e.js","assets/CodeEditor-CigpeREG.js","assets/ConditionRow-FRqe5mV9.js","assets/Config-Bye0SFVW.js","assets/Connections-1r5FNJTw.js","assets/Copy-xLJK18ri.js","assets/Coverage-C9wHHZbt.js","assets/DaeCode-DEjXqvav.js","assets/Delete-HQ5S6-JZ.js","assets/Dns-CsAXSf3H.css","assets/Dns-DTqk3ZFq.js","assets/Donut-aipLcZzv.js","assets/Editors-DnopwLy-.js","assets/Editors-rPgk_VZK.css","assets/Events-Xz-GK6BY.js","assets/FlagPicker-ewb3VJnn.js","assets/Flows-BekA1vQh.css","assets/Flows-IuwaTpnn.js","assets/GridList-CC4w_Iq3.js","assets/ItemText-M_HsyHL5.js","assets/LinkOut-qIg2xTwZ.js","assets/Login-DJCG2vwM.js","assets/Logs-D0n5s98X.js","assets/NodePath-Gfq-By42.js","assets/Nodes-Dz09mbUJ.css","assets/Nodes-jRUmoonJ.js","assets/NumberField-CN_dFkWR.js","assets/Overview-COMXVcWR.js","assets/Policies-z3gmliEw.js","assets/ProbeOptionsDialog-CbXH9b0U.js","assets/Rules-CtSzVqw5.js","assets/SearchDialog-VEh8xwPh.js","assets/SearchList-Dzx-0VF7.js","assets/SearchSelect-CgvsaAJS.js","assets/Select-B1IhE7cv.js","assets/Settings-BVpmQMTB.css","assets/Settings-CkSpiOkK.js","assets/Sparkline-CVtVW7e7.js","assets/SubscriptionFields-Ba8FbY5-.js","assets/Table-DMzu4x5t.js","assets/Tabs-Ba8gYhNB.js","assets/Tag-BJayNrqV.js","assets/TimeCell-xHoiaHia.js","assets/Toolbar-Br0J4-YM.js","assets/Trace-Dvmwxvpm.js","assets/TwemojiCountryFlags-Bymva2JV.woff2","assets/Virtualizer-BUkJzK8u.js","assets/WallpaperSettings-O3JHRr6B.js","assets/XhttpOptions-scgNhwKR.js","assets/_commonjsHelpers-CXUWDbkB.js","assets/activity-Db7VRWAG.css","assets/activity-DwYuxZaT.js","assets/array-C0VuvQyb.js","assets/auth-BsSyBMZz.js","assets/auth-C9L8giMi.js","assets/daeTokens-BVtuNnWZ.js","assets/duck-night-CbKHyiul.webp","assets/files-Dt8K7QfP.js","assets/flows-Bh9kBRHT.js","assets/fonts-C5_wsAqZ.css","assets/geodata-X0pHz03D.js","assets/geodataUpdate-Nz09dXaJ.js","assets/glass-BqF6QW1y.js","assets/glass-D3s0PXdk.css","assets/gorges-dark-FlgXSNn1.webp","assets/gorges-light-DCWkLX37.webp","assets/impact-B8feJDtJ.css","assets/index-DUM-iwa2.js","assets/index-DkZLaQoO.js","assets/index-OR7DFCdG.css","assets/ipLookup-BJsoFuhR.js","assets/ipLookup-BYorpVJi.css","assets/labels-D8xxfRTQ.js","assets/lake-dark-B_VaUlAe.webp","assets/lake-light-oWll36-V.webp","assets/lens-BItwTMX6.js","assets/logo-obi05X1B.svg","assets/logs-DniNK6NG.js","assets/match.worker-B2aIccpg.js","assets/nav-BO8viH9G.js","assets/nav-BXcfcRvQ.js","assets/nav-BYHXS5Ks.js","assets/nav-BpCoFZ5Q.js","assets/nav-C5gqT-qo.js","assets/nav-CE1PQnEs.js","assets/nav-CrX-mOuD.js","assets/nodes-zKvLj1EG.js","assets/outbounds-C-QT9t_b.js","assets/probe-P4V7qZUr.js","assets/recorder-BHyqDNp5.js","assets/rule-CaRkSdGM.js","assets/square-dark-CG0rwsS1.webp","assets/square-light-OU6dsCf9.webp","assets/taishan-dark-BI3cd4fj.webp","assets/taishan-light-Dip0HmJZ.webp","assets/useGridSelectionCheckbox-BJpzXB14.js","assets/useQuickRule-Row9eJav.js","assets/vendor-editor-BRV-W12m.js","assets/vendor-react-64fcanlc.js","assets/wall-dark-DCO0xUUO.webp","assets/wall-light-BYfte2Bi.webp","assets/wallpaper-CEC7gitM.js","index.html"];
// Each language's catalogue and stylesheets in this build, cached only for a language a reader uses. A partial
// language's list holds the reference language's files too, since it loads them.
const LANGUAGES = {"zh-TW":["assets/fonts-tc-D9rvq3k7.css","assets/locale-zh-TW-activity-DOTbfPAr.js","assets/locale-zh-TW-core-c3IhMc6J.js","assets/locale-zh-TW-rest-lRUY6WQn.js"],"zh-CN":["assets/fonts-sc-Dyn9aW84.css","assets/locale-zh-CN-activity-D8T7NKkt.js","assets/locale-zh-CN-core-CSyLpr37.js","assets/locale-zh-CN-rest-BApZZHxX.js"],"en":["assets/locale-en-activity-CKYMDNMD.js","assets/locale-en-core-cKs0VyvX.js","assets/locale-en-rest-DsLTKGly.js"]};
// The mock backend's chunk, cached only for a page that runs on it.
const MOCK = ["assets/index-DjyGwNyS.js"];
const ROOT = new URL(self.registration.scope);

// A new build takes over on the next online load, including open dashboard tabs.
// Each build records when it was installed, so activation can tell the build it replaces from older ones.
const STAMP = new URL('__installed__', ROOT);
// index.html keeps its name across builds, so it is fetched past the HTTP cache: a caching proxy cannot hand the new
// build an old shell. A file under assets/ is named after its content hash, so the copy the page already loaded through
// the HTTP cache is the same file and is not downloaded again.
const precacheRequest = url => (url.startsWith('assets/') ? url : new Request(url, {cache: 'reload'}));
self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => Promise.all([cache.addAll(PRECACHE.map(precacheRequest)), cache.put(STAMP, new Response(String(Date.now())))]))
      .then(() => self.skipWaiting())
  );
});
// A page loads its catalogue and backend before this worker controls it, so it reports the language it shows and
// whether it runs on the mock, to have them cached.
self.addEventListener('message', event => {
  if (event.data?.build === true) {
    event.ports[0]?.postMessage(BUILD);
    return;
  }
  const lang = event.data?.language;
  const files = [...(typeof lang === 'string' && Object.hasOwn(LANGUAGES, lang) ? LANGUAGES[lang] : []), ...(event.data?.mock === true ? MOCK : [])];
  if (!files.length) return;
  event.waitUntil(caches.open(CACHE).then(cache => Promise.all(files.map(async url => (await cache.match(url, {ignoreVary: true})) ?? cache.add(url)))));
});
// The build just replaced stays: tabs still showing it load their remaining chunks from it until reloaded.
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const older = [];
      for (const key of await caches.keys()) {
        if (!key.startsWith(PREFIX) || key === CACHE) continue;
        const stamp = await (await caches.open(key)).match(STAMP);
        older.push({key, installed: stamp ? Number(await stamp.text()) : 0});
      }
      older.sort((a, b) => b.installed - a.installed);
      await Promise.all(older.slice(1).map(({key}) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

function hit(response) {
  if (!response) return Response.error();
  const headers = new Headers(response.headers);
  headers.set('x-doona-sw', 'hit');
  return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== ROOT.origin || /\/api(?:\/|$)/.test(url.pathname) || !url.pathname.startsWith(ROOT.pathname)) return;
  if (url.pathname.startsWith(new URL('lite/', ROOT).pathname)) return;
  const navigation = request.mode === 'navigate';
  if (!navigation && !/^(assets|fonts|icons)\//.test(url.pathname.slice(ROOT.pathname.length))) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (navigation) {
        try {
          return await fetch(request);
        } catch {
          return hit(await cache.match(new URL('index.html', ROOT)));
        }
      }
      // A build file is the same for every requester, so a server's Vary: Origin must not turn a cached copy into a miss.
      const response = (await cache.match(request, {ignoreVary: true})) ?? (await caches.match(request, {ignoreVary: true}));
      if (response) return hit(response);
      const fresh = await fetch(request);
      // A host may answer a missing file with the page; caching that would keep the file missing once it is installed.
      if (fresh.ok && fresh.type === 'basic' && !fresh.redirected && !fresh.headers.get('content-type')?.includes('html'))
        await cache.put(request, fresh.clone());
      return fresh;
    })()
  );
});
