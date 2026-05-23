'use strict';

const RESULT_COUNT = 12;
const INITIAL_VIRTUAL_COUNT = 4;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function createYoutubeLikeFixture(options = {}) {
  const resultCount = Number.isFinite(options.resultCount) ? options.resultCount : RESULT_COUNT;
  const initialVirtualCount = Number.isFinite(options.initialVirtualCount) ? options.initialVirtualCount : INITIAL_VIRTUAL_COUNT;
  const cardTitles = Array.from({ length: resultCount }, (_, index) => `Fixture Video Result ${index + 1}`);
  const virtualTitles = Array.from({ length: resultCount }, (_, index) => `Virtualized Fixture Result ${index + 1}`);
  const decoyTexts = {
    hidden: 'Hidden Decoy Result Must Not Appear',
    zeroSize: 'Zero Size Decoy Result Must Not Appear',
    offLayout: 'Off Layout Decoy Result Must Not Appear',
    ariaHidden: 'Aria Hidden Decoy Result Must Not Appear'
  };

  const cardHtml = cardTitles.map((title, index) => `
    <article class="result-card" data-testid="result-card" data-index="${index + 1}">
      <a class="thumbnail" href="/watch?v=fixture-${index + 1}" aria-label="Open ${escapeHtml(title)}"></a>
      <div class="metadata">
        <h2>${escapeHtml(title)}</h2>
        <p>${(index + 1) * 3}K views • ${index + 1} days ago • Fixture Channel ${index + 1}</p>
      </div>
    </article>`).join('\n');

  const initialVirtualHtml = virtualTitles.slice(0, initialVirtualCount).map((title, index) => `
    <article class="virtual-card" data-testid="virtual-card" data-virtual-index="${index + 1}">
      <h3>${escapeHtml(title)}</h3>
      <p>Virtual metadata ${index + 1}</p>
    </article>`).join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>YouTube-like Browser Control Fixture</title>
<style>
  body { margin: 0; font-family: Arial, sans-serif; min-height: 2400px; }
  header { position: sticky; top: 0; z-index: 3; background: #fff; border-bottom: 1px solid #ddd; padding: 12px; }
  main { display: grid; grid-template-columns: 360px 1fr; gap: 24px; padding: 24px; }
  #player { position: sticky; top: 58px; height: 240px; background: #111; color: #fff; border-radius: 16px; display: grid; place-items: center; outline: 3px solid #f00; }
  #results-region { height: 520px; overflow: auto; overscroll-behavior: contain; border: 1px solid #ccc; border-radius: 12px; padding: 16px; }
  .result-card, .virtual-card { min-height: 150px; display: grid; grid-template-columns: 180px 1fr; gap: 16px; border-bottom: 1px solid #eee; padding: 14px 0; }
  .thumbnail { background: linear-gradient(135deg, #ddd, #888); border-radius: 8px; }
  .hidden-decoy, [hidden] { display: none !important; }
  .zero-size-decoy { width: 0; height: 0; overflow: hidden; position: absolute; }
  .off-layout-decoy { position: absolute; left: -100000px; top: -100000px; }
</style>
</head>
<body>
  <header><input id="search" aria-label="Search" value="browser control"></header>
  <main>
    <section id="player" tabindex="0" role="application" aria-label="Focused media player">
      Focused media area intercepts Space and PageDown
    </section>
    <section id="results-region" data-testid="results-region" aria-label="Search results">
      ${cardHtml}
      <section id="virtualized-results" data-testid="virtualized-results" aria-label="Virtualized results">
        ${initialVirtualHtml}
      </section>
    </section>
  </main>
  <div class="hidden-decoy">${decoyTexts.hidden}</div>
  <div class="zero-size-decoy">${decoyTexts.zeroSize}</div>
  <div class="off-layout-decoy">${decoyTexts.offLayout}</div>
  <div aria-hidden="true">${decoyTexts.ariaHidden}</div>
<script>
(() => {
  const player = document.getElementById('player');
  const region = document.getElementById('results-region');
  const virtual = document.getElementById('virtualized-results');
  const virtualTitles = ${JSON.stringify(virtualTitles)};
  player.focus();
  player.addEventListener('keydown', event => {
    if (event.code === 'Space' || event.code === 'PageDown') {
      event.preventDefault();
      player.dataset.interceptedKey = event.code;
    }
  });
  region.addEventListener('scroll', () => {
    const rendered = virtual.querySelectorAll('[data-testid="virtual-card"]').length;
    if (region.scrollTop + region.clientHeight >= region.scrollHeight - 40 && rendered < virtualTitles.length) {
      for (let i = rendered; i < Math.min(rendered + 4, virtualTitles.length); i += 1) {
        const card = document.createElement('article');
        card.className = 'virtual-card';
        card.dataset.testid = 'virtual-card';
        card.dataset.virtualIndex = String(i + 1);
        card.innerHTML = '<h3>' + virtualTitles[i] + '</h3><p>Virtual metadata ' + (i + 1) + '</p>';
        virtual.appendChild(card);
      }
    }
  });
})();
</script>
</body>
</html>`;

  return { html, cardTitles, virtualTitles, decoyTexts, resultCount, initialVirtualCount };
}

module.exports = { createYoutubeLikeFixture, RESULT_COUNT, INITIAL_VIRTUAL_COUNT };
