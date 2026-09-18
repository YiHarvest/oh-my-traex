const icons = {
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9"/><path d="M10 21h4"/>',
  'list-checks': '<path d="m3 6 2 2 4-4"/><path d="M11 6h10"/><path d="m3 14 2 2 4-4"/><path d="M11 14h10"/>',
  'monitor-dot': '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><circle cx="17" cy="9" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  'circle-help': '<circle cx="12" cy="12" r="10"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 1-1 1.7M12 17h.01"/>',
  'user-round': '<circle cx="12" cy="8" r="4"/><path d="M4 22a8 8 0 0 1 16 0"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M19 9h4M1 15h4M19 15h4"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  'list-plus': '<path d="M8 6h13M8 12h13M8 18h8M3 6h.01M3 12h.01M3 18h.01M19 16v6M16 19h6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 13h10"/>',
  'octagon-alert': '<path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9Z"/><path d="M12 8v5M12 17h.01"/>',
};

export function createIcons(root = document) {
  for (const element of root.querySelectorAll('[data-lucide]')) {
    const body = icons[element.dataset.lucide];
    if (!body) continue;
    element.outerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
  }
}
