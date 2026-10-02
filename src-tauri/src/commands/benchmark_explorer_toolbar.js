// A self-contained app control: it does not depend on website DOM or React internals.
(() => {
  if (window.top !== window || location.origin !== 'https://aiolm.vercel.app') return;
  const copy = window.__AIOLM_EXPLORER_COPY__;
  const mount = () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { position:fixed; inset:auto 12px 12px; z-index:2147483647; color-scheme:light dark; }
      section { display:flex; align-items:center; gap:16px; padding:12px 16px;
        border:1px solid #888; border-radius:12px; background:Canvas; color:CanvasText;
        box-shadow:0 4px 24px #0003; font:14px/1.5 system-ui,sans-serif; }
      p { flex:1; margin:0; } button { border:1px solid #888; border-radius:8px; padding:10px 16px;
        background:Canvas; color:CanvasText; font:inherit; font-weight:600; cursor:pointer; }
      button:disabled { opacity:.5; cursor:default; } button:focus-visible { outline:3px solid Highlight; }
      @media(max-width:600px) { section { flex-wrap:wrap; gap:8px; } button { width:100%; } }
    `;
    const section = document.createElement('section');
    section.setAttribute('aria-label', 'AioLM');
    const hint = document.createElement('p');
    hint.textContent = copy.hint;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = copy.label;
    const detailId = () => location.pathname.match(/^\/(?:en|ko|ja|zh)\/benchmarks\/([A-Za-z0-9_-]{1,110})\/?$/)?.[1];
    const update = () => { button.disabled = !detailId(); };
    button.addEventListener('click', () => {
      const id = detailId();
      if (id) location.assign(`/__aiolm_profile_import/${id}`);
    });
    section.append(hint, button);
    root.append(style, section);
    document.body.append(host);
    // Next.js can change the route without a document navigation. Observe
    // content changes instead of patching its router or history methods.
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', update);
    update();
    // Keep the last rows/controls visible above the app toolbar.
    const resize = new ResizeObserver(() => {
      document.body.style.paddingBottom = `${host.getBoundingClientRect().height + 24}px`;
    });
    resize.observe(host);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
