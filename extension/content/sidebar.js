(async () => {
  const asin = window.location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/)?.[1];
  if (!asin) return;
  if (document.getElementById('rl-sidebar-host')) return; // already injected

  const host = document.createElement('div');
  host.id = 'rl-sidebar-host';
  Object.assign(host.style, {
    position: 'fixed',
    top: '0',
    right: '-440px',
    width: '420px',
    height: '100vh',
    zIndex: '2147483647',
    transition: 'right 0.28s cubic-bezier(0.4, 0, 0.2, 1)',
    boxShadow: '-4px 0 24px rgba(0,0,0,0.18)',
    border: 'none',
  });

  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL(`sidebar/panel.html?asin=${asin}`);
  Object.assign(iframe.style, {
    width: '100%',
    height: '100%',
    border: 'none',
    display: 'block',
  });
  iframe.setAttribute('allow', '');

  host.appendChild(iframe);
  document.documentElement.appendChild(host);

  let open = true;
  host.style.right = '0'; // auto-open on product page load

  const toggle = () => {
    open = !open;
    host.style.right = open ? '0' : '-440px';
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TOGGLE_SIDEBAR') toggle();
  });
})();
